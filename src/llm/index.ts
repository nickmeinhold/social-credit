/**
 * Assemble the BudgetRouter from config + secrets.
 *
 * The split is deliberate and is the whole security model for the forkable
 * repo: **config** (committed) says which providers are enabled, which model,
 * and the daily free-tier cap; **the environment** (GitHub secrets) supplies the
 * keys. A provider only joins the router if it's enabled AND its key is present,
 * so a fork that only sets GEMINI_API_KEY just runs on Gemini.
 */
import type { Config, ProviderConfig } from "../config.js";
import { BudgetRouter, type Capped } from "./router.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatProvider } from "./openai.js";

/**
 * Pure gate for the upstream-owner gateway provider. The owner's credits are
 * used ONLY when all three hold: the fork enabled the provider, it configured
 * the gateway `baseURL`, and a `PROXY_TOKEN` grant is present in the env. Any
 * gap → false → the fork falls back to its own free providers (no hard fail).
 *
 * Factored out as a pure function so the security-critical "default to NOT
 * using the owner's creds" rule is directly unit-testable.
 */
export function gatewayGranted(
  cfg: Pick<ProviderConfig, "enabled" | "baseURL"> | undefined,
  proxyToken: string | undefined,
): boolean {
  return Boolean(cfg?.enabled && cfg.baseURL && proxyToken);
}

export function buildRouter(cfg: Config): BudgetRouter {
  const capped: Capped[] = [];
  const p = cfg.providers;

  if (p.anthropic?.enabled) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) capped.push({ llm: new AnthropicProvider(key, p.anthropic.model), dailyCap: p.anthropic.dailyCap });
    else console.warn("[llm] anthropic enabled but ANTHROPIC_API_KEY is unset — skipping");
  }

  if (p.claudeMax?.enabled) {
    // No API key — the `claude` CLI authenticates via CLAUDE_CODE_OAUTH_TOKEN
    // in the environment. We just confirm the token is present.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
      capped.push({ llm: new ClaudeCliProvider(p.claudeMax.model), dailyCap: p.claudeMax.dailyCap });
    else console.warn("[llm] claudeMax enabled but CLAUDE_CODE_OAUTH_TOKEN is unset — skipping");
  }

  if (p.gemini?.enabled) {
    const key = process.env.GEMINI_API_KEY;
    if (key) capped.push({ llm: new GeminiProvider(key, p.gemini.model), dailyCap: p.gemini.dailyCap });
    else console.warn("[llm] gemini enabled but GEMINI_API_KEY is unset — skipping");
  }

  if (p.github?.enabled) {
    // GitHub Models authenticates with the workflow's built-in GITHUB_TOKEN
    // (grant `models: read`); a dedicated PAT in GITHUB_MODELS_TOKEN wins if set.
    const key = process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN;
    if (key)
      capped.push({
        llm: new OpenAICompatProvider(key, p.github.model, p.github.baseURL),
        dailyCap: p.github.dailyCap,
      });
    else console.warn("[llm] github enabled but no GITHUB_MODELS_TOKEN/GITHUB_TOKEN — skipping");
  }

  if (p.gateway?.enabled) {
    // Upstream-owner credits "on request": the owner runs an OpenAI-compatible
    // gateway holding their real keys and grants this fork a REVOCABLE token.
    // Requires BOTH a baseURL (where the gateway lives) AND the PROXY_TOKEN
    // secret (the grant). Missing either → skip, so an ungranted fork silently
    // falls back to its own free providers instead of hard-failing.
    const token = process.env.PROXY_TOKEN;
    if (gatewayGranted(p.gateway, token))
      capped.push({
        llm: new OpenAICompatProvider(token!, p.gateway.model, p.gateway.baseURL, "gateway"),
        dailyCap: p.gateway.dailyCap,
      });
    else if (!p.gateway.baseURL)
      console.warn("[llm] gateway enabled but no baseURL configured — skipping");
    else console.warn("[llm] gateway enabled but PROXY_TOKEN is unset (not granted) — skipping");
  }

  return new BudgetRouter(capped);
}
