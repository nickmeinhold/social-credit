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
import { meet } from "./swarm/circle.js";
import { dreamOne } from "./swarm/dream.js";
import { maybeHoldCeremony } from "./swarm/ceremony.js";
import { enqueue, list, setStatus } from "./bridge/queue.js";

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

  /** Hold a naming ceremony if anyone has matured. */
  async ceremonyOnce(): Promise<void> {
    const named = await maybeHoldCeremony(this.agents, this.cfg.swarm.ceremonyMinRounds);
    if (named) console.log(`[ceremony] the circle named someone: ${named}`);
  }

  /** The slow cadence: dream, then maybe a ceremony. Run by the reflect cron. */
  async reflectOnce(): Promise<void> {
    await this.safe("dream", () => this.dreamOnce());
    await this.safe("ceremony", () => this.ceremonyOnce());
  }

  /**
   * One complete pass for CI: poll sources, run a swarm round, flush. Each step
   * is isolated so a capped provider or a flaky platform can't abort the rest —
   * the GitHub Action just records the error and the next cron tick retries.
   * Logs budget usage so the workflow output shows headroom against free tiers.
   */
  async tickOnce(): Promise<void> {
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
