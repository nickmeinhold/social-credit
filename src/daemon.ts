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
import { meet } from "./swarm/circle.js";
import { dreamOne } from "./swarm/dream.js";
import { maybeHoldCeremony, inauguralCeremony } from "./swarm/ceremony.js";
import { dataPath } from "./paths.js";
import { enqueue, list, setStatus } from "./bridge/queue.js";
import {
  decide,
  history as engagementHistory,
  record as recordEngagement,
  jitteredDelay,
  type EngagementKind,
  type EngagementSurface,
} from "./bridge/engagement.js";
import { starRepo, isRepoSlug } from "./bridge/github-star.js";
import type { Boost } from "./swarm/arena.js";
import type { PostRef } from "./platforms/types.js";

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
      // Boosts no longer just surface in the transcript — `engageBoosts` below
      // turns them into REAL stars/likes/reposts, gated by the engagement policy.
    }
    console.log(`[swarm] round done — ${boosts.length} boost(s), ${drafts.length} draft(s)`);
    await this.engageBoosts(boosts);
  }

  /**
   * Turn the round's boosts into REAL outward engagement — but discriminatingly,
   * never as a ring. Two surfaces:
   *   - INTERNAL circle: a GitHub star on a circle member's repo.
   *   - EXTERNAL social: a like/repost of the boosted post on the platform it
   *     came from.
   *
   * Every candidate action passes through `decide()` (the ring-protection
   * policy: daily cap + min interval + non-reciprocity + dedupe). We process one
   * boost at a time, sleeping a jittered interval between successful actions so
   * the cadence never looks like a bot metronome. Anything `decide` rejects is
   * skipped with a logged reason and NOT retried this round.
   *
   * Inert unless `engagement.enabled` — the default. We still take the early
   * return cheaply so a disabled fork pays nothing.
   */
  async engageBoosts(boosts: Boost[]): Promise<void> {
    const cfg = this.cfg.engagement;
    if (!cfg.enabled || cfg.dailyCap <= 0) return;

    for (const boost of boosts) {
      const action = this.resolveEngagement(boost);
      if (!action) continue; // boost didn't map to anyone we can engage

      // decide() is re-read each iteration so an action performed earlier this
      // round counts against the cap/interval/reciprocity for the next.
      const verdict = decide(cfg, engagementHistory(), {
        kind: action.kind,
        actor: action.actor,
        target: action.target,
      });
      if (verdict !== "ok") {
        console.log(`[engage] skip ${action.kind} ${action.target}: ${verdict}`);
        continue;
      }

      try {
        await action.perform();
        recordEngagement({
          kind: action.kind,
          surface: action.surface,
          actor: action.actor,
          target: action.target,
        });
        console.log(`[engage] ${action.kind} ${action.target} (actor ${action.actor})`);
      } catch (err) {
        console.error(`[engage] ${action.kind} ${action.target} FAILED:`, (err as Error).message);
        continue; // a failed action isn't recorded, so it isn't a "real" engagement
      }

      // Jittered pause before the NEXT action — the metronome-breaker. We only
      // pause after a successful action (skips are free and instant).
      await sleep(jitteredDelay(cfg));
    }
  }

  /**
   * Map a boost to a concrete, performable engagement, or null if it doesn't
   * correspond to anyone in the circle / any engageable post. This is the
   * NON-reciprocity-by-construction point: we engage based on what the swarm
   * found worth boosting (`actor` = the content's owner), never "because they
   * engaged us" — we have no inbound-engagement signal and deliberately don't
   * build one.
   */
  private resolveEngagement(boost: Boost):
    | {
        kind: EngagementKind;
        surface: EngagementSurface;
        actor: string;
        target: string;
        perform: () => Promise<void>;
      }
    | null {
    const link = boost.target.link;

    // INTERNAL: the boosted content belongs to a circle member with a GitHub
    // repo (matched by the repo URL appearing in the link) -> star that repo.
    for (const person of this.cfg.circle) {
      if (!person.repo || !isRepoSlug(person.repo)) continue;
      if (link && link.toLowerCase().includes(`github.com/${person.repo.toLowerCase()}`)) {
        return {
          kind: "star",
          surface: "github",
          actor: person.id,
          target: person.repo,
          perform: async () => void (await starRepo(person.repo!)),
        };
      }
    }

    // EXTERNAL: the boosted content is a social post -> like it on the platform
    // it came from, if that adapter supports `like`. The post's host identifies
    // the platform; the author handle (from the URL) is the reciprocity actor.
    if (link) {
      const ext = this.matchSocialLink(link);
      if (ext) {
        const adapter = this.adapters.find((a) => a.name === ext.surface);
        if (adapter?.like) {
          const ref: PostRef = { url: link };
          return {
            kind: "like",
            surface: ext.surface,
            actor: ext.actor,
            target: link,
            perform: async () => void (await adapter.like!(ref)),
          };
        }
      }
    }

    return null;
  }

  /** Identify a social post URL's platform + author handle, or null. */
  private matchSocialLink(
    link: string,
  ): { surface: Extract<EngagementSurface, "bluesky" | "mastodon">; actor: string } | null {
    const bsky = link.match(/bsky\.app\/profile\/([^/]+)\/post\//);
    if (bsky) return { surface: "bluesky", actor: bsky[1] };
    // Mastodon permalinks look like https://instance/@user/123 — the host+user
    // identify the actor for reciprocity purposes.
    const masto = link.match(/^https?:\/\/([^/]+)\/@([^/]+)\/\d+/);
    if (masto) return { surface: "mastodon", actor: `${masto[2]}@${masto[1]}` };
    return null;
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

/** Await `ms` milliseconds. Used to space out outward engagements (jitter). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
