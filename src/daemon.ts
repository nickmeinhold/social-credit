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
import { Claude } from "./llm/claude.js";
import { buildAdapters, type PlatformAdapter } from "./platforms/index.js";
import { pollNewItems } from "./sources/rss.js";
import { Agent } from "./swarm/agent.js";
import { runRound, type Candidate } from "./swarm/arena.js";
import { seedPersona } from "./swarm/persona.js";
import { loadPersona, savePersona } from "./swarm/store.js";
import { enqueue, list, setStatus } from "./bridge/queue.js";

export class Daemon {
  private adapters: PlatformAdapter[];
  private llm?: Claude;
  private agents: Agent[] = [];
  /** Candidates accumulated from recent own-content for the swarm to chew on. */
  private recentCandidates: Candidate[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private cfg: Config) {
    this.adapters = buildAdapters(cfg);
    if (cfg.swarm.enabled) {
      this.llm = new Claude(cfg.anthropic.apiKey, cfg.anthropic.model);
      // Load each agent's evolved persona from disk, or seed it on first run.
      this.agents = cfg.swarm.agents.map((seed) => {
        const persona = loadPersona(seed.name) ?? seedPersona(seed);
        savePersona(persona);
        return new Agent(persona, this.llm!);
      });
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
