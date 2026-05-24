/**
 * Config loading + validation.
 *
 * Config lives in `social-credit.config.jsonc` (gitignored — it holds tokens).
 * We support `${ENV_VAR}` interpolation so secrets can live in the environment
 * instead of on disk. JSONC is parsed by stripping comments then JSON.parse —
 * good enough for a hand-edited config and avoids a dependency.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AgentSeed {
  /** Display name / handle inside the sandbox. */
  name: string;
  /** A one-paragraph seed personality. The agent evolves away from this. */
  seedBio: string;
  /** Disciplines this agent draws on when cross-pollinating ideas. */
  disciplines: string[];
}

export interface Config {
  /** Where to discover the user's own content. */
  sources: {
    rss: string[];
  };
  /** Credentials per platform. Absent key = platform disabled. */
  platforms: {
    bluesky?: { identifier: string; appPassword: string; service?: string };
    mastodon?: { instance: string; accessToken: string };
    linkedin?: { accessToken: string; authorUrn: string };
  };
  swarm: {
    enabled: boolean;
    agents: AgentSeed[];
    /** How often the arena runs a discussion round, in ms. */
    discussionIntervalMs: number;
    /** 0..1 — an agent only boosts/reposts content it rates at or above this. */
    boostThreshold: number;
  };
  bridge: {
    /** Auto-publish the user's OWN content (from `sources`) without approval. */
    autoPostOwnContent: boolean;
    /** Hold swarm-generated original content in the queue for manual approval. */
    requireApprovalForSwarmContent: boolean;
  };
  anthropic: {
    apiKey: string;
    /** Model for the agent swarm. Haiku by default — many cheap agents. */
    model: string;
  };
  /** How often the daemon polls RSS sources, in ms. */
  pollIntervalMs: number;
}

const DEFAULTS = {
  swarm: { discussionIntervalMs: 5 * 60_000, boostThreshold: 0.8 },
  anthropic: { model: "claude-haiku-4-5-20251001" },
  pollIntervalMs: 10 * 60_000,
};

/** Replace ${VAR} with process.env.VAR; throws if a referenced var is unset. */
function interpolateEnv(raw: string): string {
  return raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined)
      throw new Error(`Config references \${${name}} but it is not set in the environment`);
    return v;
  });
}

/** Strip // line and /* block *​/ comments so we can JSON.parse JSONC. */
function stripJsonComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function loadConfig(path = "social-credit.config.jsonc"): Config {
  const abs = resolve(path);
  const raw = interpolateEnv(readFileSync(abs, "utf8"));
  const parsed = JSON.parse(stripJsonComments(raw)) as Partial<Config>;

  // Shallow-merge defaults. Deep merge isn't worth a dependency here.
  const cfg: Config = {
    sources: { rss: [], ...parsed.sources },
    platforms: parsed.platforms ?? {},
    swarm: {
      enabled: false,
      agents: [],
      ...DEFAULTS.swarm,
      ...parsed.swarm,
    },
    bridge: {
      autoPostOwnContent: false,
      requireApprovalForSwarmContent: true,
      ...parsed.bridge,
    },
    anthropic: {
      apiKey: "",
      ...DEFAULTS.anthropic,
      ...parsed.anthropic,
    },
    pollIntervalMs: parsed.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
  };

  if (cfg.swarm.enabled && !cfg.anthropic.apiKey)
    throw new Error("swarm.enabled is true but anthropic.apiKey is empty");

  return cfg;
}
