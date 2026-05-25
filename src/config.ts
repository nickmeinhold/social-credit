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
import type { Person } from "./swarm/circle.js";

export interface AgentSeed {
  /** Display name / handle inside the sandbox. */
  name: string;
  /** A one-paragraph seed personality. The agent evolves away from this. */
  seedBio: string;
  /** Disciplines this agent draws on when cross-pollinating ideas. */
  disciplines: string[];
  /** Optional: pin to a provider so its base model flavours the voice. */
  provider?: string;
  /** True if this agent already has its name (upstream). On a FORK the welcome
   *  rite strips this and the new circle renames it. */
  alreadyNamed?: boolean;
}

/** Per-provider config. The API KEY is NOT here — it comes from a secret/env. */
export interface ProviderConfig {
  enabled: boolean;
  model: string;
  /** Calls/day to stay just under this provider's free tier. */
  dailyCap: number;
  /** OpenAI-compatible base URL override (e.g. point "github" at OpenAI). */
  baseURL?: string;
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
    /** Let agents dream (reflect on the circle). Run via `dream` / reflect cron. */
    dream: boolean;
    /** Min rounds before an agent can be given a chosen name at a ceremony. */
    ceremonyMinRounds: number;
  };
  /** The human the swarm acts for, named in dreams. */
  ownerName: string;
  /** Humans the agents know. Co-agents are added to each circle automatically. */
  circle: Person[];
  bridge: {
    /** Auto-publish the user's OWN content (from `sources`) without approval. */
    autoPostOwnContent: boolean;
    /** Hold swarm-generated original content in the queue for manual approval. */
    requireApprovalForSwarmContent: boolean;
  };
  /** LLM providers. Keys come from env/secrets, not from here. */
  providers: {
    /** Claude via API key (per-token billing). */
    anthropic?: ProviderConfig;
    /** Claude via Max/Pro subscription (the `claude` CLI + OAuth token). */
    claudeMax?: ProviderConfig;
    gemini?: ProviderConfig;
    github?: ProviderConfig;
    /**
     * Upstream-owner LLM credits, used "on request". The owner runs an
     * OpenAI-compatible gateway holding their real keys and issues a per-fork
     * REVOCABLE token. A fork points `baseURL` at that gateway and supplies the
     * granted token via the `PROXY_TOKEN` secret (env only — never committed).
     * Disabled by default: a fork must be explicitly granted access and opt in.
     */
    gateway?: ProviderConfig;
  };
  /** How often the daemon polls RSS sources, in ms (daemon mode only). */
  pollIntervalMs: number;
}

const DEFAULTS = {
  swarm: { discussionIntervalMs: 5 * 60_000, boostThreshold: 0.8, dream: true, ceremonyMinRounds: 12 },
  pollIntervalMs: 10 * 60_000,
};

/** Replace ${VAR} with process.env.VAR; missing vars become "" (with a warning)
 *  so a fork that hasn't set every optional secret still loads. */
function interpolateEnv(raw: string): string {
  return raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) {
      console.warn(`[config] \${${name}} not set — using empty string`);
      return "";
    }
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
  // Strip comments BEFORE interpolating env, so ${...} written inside comments
  // (e.g. documentation) isn't treated as a real reference.
  const stripped = stripJsonComments(readFileSync(abs, "utf8"));
  const parsed = JSON.parse(interpolateEnv(stripped)) as Partial<Config>;

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
    providers: parsed.providers ?? {},
    ownerName: parsed.ownerName ?? "your human",
    circle: parsed.circle ?? [],
    pollIntervalMs: parsed.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
  };

  const anyProvider = Object.values(cfg.providers).some((p) => p?.enabled);
  if (cfg.swarm.enabled && !anyProvider)
    throw new Error("swarm.enabled is true but no provider is enabled in `providers`");

  return cfg;
}
