/**
 * Assemble the BudgetRouter from config + secrets.
 *
 * The split is deliberate and is the whole security model for the forkable
 * repo: **config** (committed) says which providers are enabled, which model,
 * and the daily free-tier cap; **the environment** (GitHub secrets) supplies the
 * keys. A provider only joins the router if it's enabled AND its key is present,
 * so a fork that only sets GEMINI_API_KEY just runs on Gemini.
 */
import type { Config } from "../config.js";
import { BudgetRouter, type Capped } from "./router.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatProvider } from "./openai.js";

export function buildRouter(cfg: Config): BudgetRouter {
  const capped: Capped[] = [];
  const p = cfg.providers;

  if (p.anthropic?.enabled) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) capped.push({ llm: new AnthropicProvider(key, p.anthropic.model), dailyCap: p.anthropic.dailyCap });
    else console.warn("[llm] anthropic enabled but ANTHROPIC_API_KEY is unset — skipping");
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

  return new BudgetRouter(capped);
}
