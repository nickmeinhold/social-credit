/**
 * The long-running daemon. It owns three recurring jobs and the wiring between
 * them:
 *
 *   pollSources()  every cfg.pollIntervalMs
 *     -> find the user's new blog posts (RSS)
 *     -> enqueue them as "own" content (auto-approved if configured)
 *     -> hand them to the swarm as candidates to react to
 *
 *   swarmTick()    every cfg.swarm.discussionIntervalMs
 *     -> agents discuss, rate, boost, and maybe compose original content
 *     -> boosts of the user's content become extra context; original content
 *        is queued as "swarm" (pending approval by default)
 *
 *   flushQueue()   after each of the above
 *     -> publish every "approved" item to all configured platforms
 *
 * Each job is wrapped so one platform/API failure can't kill the loop.
 */
import type { Config } from "./config.js";
import { buildRouter } from "./llm/index.js";
import { BudgetRouter } from "./llm/router.js";
import { buildAdapters, type PlatformAdapter } from "./platforms/index.js";
import { pollNewItems } from "./sources/rss.js";
import { Agent } from "./swarm/agent.js";
import { runRound, type Candidate } from "./swarm/arena.js";
import { seedPersona } from "./swarm/persona.js";
import { loadPersona, savePersona } from "./swarm/store.js";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { meet, loadRelationship, saveRelationship } from "./swarm/circle.js";
import { dreamOne } from "./swarm/dream.js";
import { composeDigest, shouldEmail, eligibleRecipients } from "./swarm/digest.js";
import { maybeHoldCeremony, inauguralCeremony } from "./swarm/ceremony.js";
import { remember } from "./swarm/persona.js";
import { dataPath } from "./paths.js";
import { enqueue, list, setStatus } from "./bridge/queue.js";
import { enqueueEmail, listEmails, setEmailStatus, sendEmail } from "./bridge/mailer.js";

export class Daemon {
  private adapters: PlatformAdapter[];
  private llm?: BudgetRouter;
  private agents: Agent[] = [];
  /** Candidates accumulated from recent own-content for the swarm to chew on. */
  private recentCandidates: Candidate[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private cfg: Config) {
    this.adapters = buildAdapters(cfg);
    if (cfg.swarm.enabled) {
      // Router reads provider keys from env (secrets); only enabled+keyed
      // providers participate. Throws if none are available.
      this.llm = buildRouter(cfg);
      // Load each agent's evolved persona from disk, or seed it on first run.
      this.agents = cfg.swarm.agents.map((seed) => {
        const persona = loadPersona(seed.name) ?? seedPersona(seed);
        savePersona(persona);
        return new Agent(persona, this.llm!);
      });
      this.seedCircles();
    }
  }

  /** One full pollSources pass. Exposed so the CLI can trigger it once. */
  async pollSources(): Promise<void> {
    const items = await pollNewItems(this.cfg.sources.rss);
    for (const it of items) {
      enqueue(
        "own",
        { text: it.title, title: it.title, link: it.link },
        this.cfg.bridge.autoPostOwnContent, // own content auto-approves if enabled
      );
      this.recentCandidates.unshift({ title: it.title, text: it.contentSnippet, link: it.link });
    }
    this.recentCandidates = this.recentCandidates.slice(0, 10);
    if (items.length) console.log(`[poll] ${items.length} new own-content item(s)`);
  }

  /** One swarm round. Exposed for `swarm:tick`. */
  async swarmTick(): Promise<void> {
    if (!this.cfg.swarm.enabled || this.agents.length === 0) return;
    const { boosts, drafts } = await runRound(this.cfg, this.llm!, this.agents, this.recentCandidates);
    for (const d of drafts) {
      if (d.kind === "original") {
        enqueue("swarm", { text: d.text }, !this.cfg.bridge.requireApprovalForSwarmContent);
      }
      // Boosts currently surface in the transcript; wiring them to native
      // repost/like endpoints per platform is the next adapter capability.
    }
    console.log(`[swarm] round done — ${boosts.length} boost(s), ${drafts.length} draft(s)`);
  }

  /** Publish everything currently approved-but-unposted. */
  async flushQueue(): Promise<void> {
    for (const item of list("approved")) {
      const results: { platform: string; url?: string }[] = [];
      for (const a of this.adapters) {
        try {
          const r = await a.publish(item.post);
          results.push({ platform: r.platform, url: r.url });
          console.log(`[post] ${item.id} -> ${r.platform} ${r.url ?? r.id ?? ""}`);
        } catch (err) {
          console.error(`[post] ${item.id} -> ${a.name} FAILED:`, (err as Error).message);
        }
      }
      if (results.length) setStatus(item.id, "posted", results);
    }
  }

  /** Make sure every agent knows every human in the config and every co-agent. */
  private seedCircles(): void {
    for (const agent of this.agents) {
      for (const human of this.cfg.circle) meet(agent.persona.name, human);
      for (const other of this.agents) {
        if (other === agent) continue;
        meet(agent.persona.name, {
          id: other.persona.name.toLowerCase(),
          name: other.persona.name,
          kind: "agent",
          // Seed first impressions from the other's origin so a birth-naming
          // has something to speak from.
          bio: other.persona.seedBio,
        });
      }
    }
  }

  /** A short, human-readable digest of recent swarm activity for dream context. */
  private recentSummary(): string {
    const cands = this.recentCandidates.map((c) => `- ${c.title ?? c.text.slice(0, 50)}`).join("\n");
    return cands || "- (a quiet stretch; no new posts from your human lately)";
  }

  /** Every agent dreams once — reflecting on the circle and updating it. */
  async dreamOnce(): Promise<void> {
    if (!this.cfg.swarm.dream) return;
    const recent = this.recentSummary();
    for (const agent of this.agents) {
      await this.safe(`dream:${agent.persona.name}`, () =>
        dreamOne(agent, this.cfg.ownerName, recent),
      );
    }
    console.log(`[dream] ${this.agents.length} agent(s) reflected`);
  }

  /**
   * Each agent may write at most one digest email this pass — to someone it
   * knows well enough (interactions threshold), hasn't emailed recently
   * (cooldown), and the dice favour (probability). We stamp `lastEmailedAt` at
   * compose time, not send time, so an email waiting in the approval queue
   * doesn't get recomposed every pass. Emails land in the queue unless
   * `bridge.autoSendEmail` is on; flushEmails() does the actual sending.
   */
  async emailOnce(): Promise<void> {
    const recent = this.recentSummary();
    for (const agent of this.agents) {
      const name = agent.persona.name;
      for (const rel of eligibleRecipients(name)) {
        if (!shouldEmail(rel, Math.random())) continue;
        await this.safe(`email:${name}->${rel.id}`, async () => {
          const draft = await composeDigest(agent, rel, recent);
          const item = enqueueEmail(draft, this.cfg.bridge.autoSendEmail);
          // Stamp the cooldown clock now so we don't recompose while it waits.
          const r = loadRelationship(name, rel.id);
          if (r) {
            r.lastEmailedAt = new Date().toISOString();
            saveRelationship(name, r);
          }
          remember(agent.persona, `Wrote ${rel.name} a note (email ${item.id})`, 0.5);
          savePersona(agent.persona);
          console.log(`[email] ${name} -> ${rel.name} queued ${item.id} (${item.status})`);
        });
        break; // one email per agent per pass — keep the swarm a gentle correspondent
      }
    }
    await this.flushEmails();
  }

  /** Send every approved-but-unsent email. Needs SMTP configured (cfg.email). */
  async flushEmails(): Promise<void> {
    if (!this.cfg.email) return; // nothing can send without SMTP creds
    for (const item of listEmails("approved")) {
      try {
        await sendEmail(item, this.cfg);
        setEmailStatus(item.id, "sent", { sentAt: new Date().toISOString(), error: undefined });
        console.log(`[email] sent ${item.id} -> ${item.toEmail}`);
      } catch (err) {
        // Leave it "approved" so the next flush retries; record why it failed.
        setEmailStatus(item.id, "approved", { error: (err as Error).message });
        console.error(`[email] send ${item.id} FAILED:`, (err as Error).message);
      }
    }
  }

  /**
   * The fork welcome rite. On a FORK only (SC_IS_FORK=true), and only once
   * (guarded by a sentinel on the swarm-state branch), the agents shed their
   * inherited names and the new circle names them afresh. Upstream this is a
   * no-op, so the owner's already-named agents keep their names.
   */
  async welcomeOnce(): Promise<void> {
    if (process.env.SC_IS_FORK !== "true") return;
    const sentinel = dataPath(".welcomed");
    if (existsSync(sentinel)) return;

    console.log("[welcome] a new circle is born — holding the inaugural naming ceremony");
    for (const a of this.agents) {
      a.persona.chosenName = undefined; // shed the inherited name
      savePersona(a.persona);
    }
    const names = await inauguralCeremony(this.agents);
    mkdirSync(dataPath(), { recursive: true });
    writeFileSync(sentinel, new Date().toISOString());
    console.log(`[welcome] the circle named its own: ${names.join(", ")}`);
  }

  /** Hold a naming ceremony if anyone has matured. */
  async ceremonyOnce(): Promise<void> {
    const named = await maybeHoldCeremony(this.agents, this.cfg.swarm.ceremonyMinRounds);
    if (named) console.log(`[ceremony] the circle named someone: ${named}`);
  }

  /** The slow cadence: dream, then maybe a ceremony. Run by the reflect cron. */
  async reflectOnce(): Promise<void> {
    await this.safe("welcome", () => this.welcomeOnce());
    await this.safe("dream", () => this.dreamOnce());
    await this.safe("email", () => this.emailOnce());
    await this.safe("ceremony", () => this.ceremonyOnce());
  }

  /**
   * One complete pass for CI: poll sources, run a swarm round, flush. Each step
   * is isolated so a capped provider or a flaky platform can't abort the rest —
   * the GitHub Action just records the error and the next cron tick retries.
   * Logs budget usage so the workflow output shows headroom against free tiers.
   */
  async tickOnce(): Promise<void> {
    await this.safe("welcome", () => this.welcomeOnce());
    await this.safe("poll", () => this.pollSources());
    await this.safe("swarm", () => this.swarmTick());
    await this.safe("flush", () => this.flushQueue());
    if (this.llm) {
      const u = this.llm.usage().map((x) => `${x.id} ${x.used}/${x.cap}`).join("  ");
      console.log(`[budget] today: ${u}`);
    }
  }

  private async safe(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      console.error(`[${label}] error:`, (err as Error).message);
    }
  }

  /** Start the timers and run forever. */
  async start(): Promise<void> {
    console.log(
      `social-credit daemon up — ${this.adapters.length} platform(s): ` +
        `${this.adapters.map((a) => a.name).join(", ") || "none"}; ` +
        `swarm ${this.cfg.swarm.enabled ? `(${this.agents.length} agents)` : "off"}`,
    );

    // Run once immediately so it's not silent for the first interval.
    await this.safe("poll", () => this.pollSources());
    await this.safe("flush", () => this.flushQueue());

    this.timers.push(
      setInterval(async () => {
        await this.safe("poll", () => this.pollSources());
        await this.safe("flush", () => this.flushQueue());
      }, this.cfg.pollIntervalMs),
    );

    if (this.cfg.swarm.enabled) {
      this.timers.push(
        setInterval(async () => {
          await this.safe("swarm", () => this.swarmTick());
          await this.safe("flush", () => this.flushQueue());
        }, this.cfg.swarm.discussionIntervalMs),
      );
    }
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}
