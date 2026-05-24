/**
 * Budget-aware router across providers.
 *
 * This is what "use Claude, Gemini and Codex but stay just below each free
 * tier" actually means in code: every provider has a `dailyCap` encoding its
 * free quota, we persist per-provider call counts for the current UTC day, and
 * each request goes to the *enabled provider with the most remaining headroom*.
 * That naturally spreads load proportionally to each free tier and never blows
 * past one. When everything is capped for the day, we throw — and the GitHub
 * Action simply records that and tries again on the next cron tick.
 *
 * The counter lives in DATA_DIR (the committed-back swarm-state branch), so the
 * budget is shared across all of a fork's runs, not reset every VM.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dataPath, DATA_DIR } from "../paths.js";
import type { LLM, CompleteOpts } from "./types.js";

interface BudgetFile {
  /** UTC date "YYYY-MM-DD" the counts belong to. */
  day: string;
  counts: Record<string, number>;
}

export interface Capped {
  llm: LLM;
  /** Calls/day to stay just under. */
  dailyCap: number;
}

const BUDGET_FILE = () => dataPath("budget.json");
const today = () => new Date().toISOString().slice(0, 10);

function load(): BudgetFile {
  if (!existsSync(BUDGET_FILE())) return { day: today(), counts: {} };
  const b = JSON.parse(readFileSync(BUDGET_FILE(), "utf8")) as BudgetFile;
  // Roll over at the UTC day boundary — free tiers reset daily.
  return b.day === today() ? b : { day: today(), counts: {} };
}

function save(b: BudgetFile): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BUDGET_FILE(), JSON.stringify(b, null, 2));
}

export class BudgetRouter implements LLM {
  readonly id = "router";
  constructor(private providers: Capped[]) {
    if (providers.length === 0)
      throw new Error("No LLM providers enabled — set at least one provider key as a secret.");
  }

  /** Remaining calls for a provider today. */
  private remaining(b: BudgetFile, id: string, cap: number): number {
    return cap - (b.counts[id] ?? 0);
  }

  async complete(o: CompleteOpts): Promise<string> {
    const b = load();

    // Honour an agent's preferred provider if it still has headroom.
    const ranked = this.providers
      .map((p) => ({ p, left: this.remaining(b, p.llm.id, p.dailyCap) }))
      .filter((x) => x.left > 0)
      .sort((a, x) => {
        if (o.preferProvider) {
          if (a.p.llm.id === o.preferProvider) return -1;
          if (x.p.llm.id === o.preferProvider) return 1;
        }
        return x.left - a.left; // most headroom first
      });

    if (ranked.length === 0)
      throw new Error("All providers at their daily free-tier cap — backing off until next tick.");

    const chosen = ranked[0].p;
    // Reserve the slot before the call so concurrent ticks don't double-spend.
    b.counts[chosen.llm.id] = (b.counts[chosen.llm.id] ?? 0) + 1;
    save(b);

    return chosen.llm.complete(o);
  }

  /** For `swarm:status` / logging: today's usage vs caps. */
  usage(): { id: string; used: number; cap: number }[] {
    const b = load();
    return this.providers.map((p) => ({
      id: p.llm.id,
      used: b.counts[p.llm.id] ?? 0,
      cap: p.dailyCap,
    }));
  }
}
