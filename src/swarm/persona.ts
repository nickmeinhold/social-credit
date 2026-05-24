/**
 * The personality model.
 *
 * A persona is NOT static. It starts from a seed bio + disciplines and then
 * drifts: every notable experience (something it read and rated, a debate it
 * had) appends to `memories`, and the traits it leans on get reinforced. The
 * system prompt we hand the LLM is *rendered from* this evolving state, so an
 * agent that keeps encountering, say, biology will literally start talking more
 * like a biologist over weeks of runtime.
 */
import type { AgentSeed } from "../config.js";

export interface Memory {
  /** ISO timestamp. */
  at: string;
  /** What happened, in the agent's own words. */
  note: string;
  /** Salience 0..1 — low-salience memories are pruned first. */
  weight: number;
}

export interface Persona {
  name: string;
  seedBio: string;
  disciplines: string[];
  /** Discipline -> affinity. Reinforced as the agent engages with each. */
  affinities: Record<string, number>;
  /** Append-only-ish episodic memory, pruned by weight when it grows. */
  memories: Memory[];
  /** Total discussion rounds this agent has participated in. */
  rounds: number;
}

const MAX_MEMORIES = 40;

export function seedPersona(seed: AgentSeed): Persona {
  return {
    name: seed.name,
    seedBio: seed.seedBio,
    disciplines: seed.disciplines,
    affinities: Object.fromEntries(seed.disciplines.map((d) => [d, 0.5])),
    memories: [],
    rounds: 0,
  };
}

/** Reinforce a discipline affinity, clamped to [0,1], with gentle decay elsewhere. */
export function reinforce(p: Persona, discipline: string, amount = 0.05): void {
  const cur = p.affinities[discipline] ?? 0.4;
  p.affinities[discipline] = Math.min(1, cur + amount);
  // Slight decay of all others keeps the distribution from saturating.
  for (const d of Object.keys(p.affinities)) {
    if (d !== discipline) p.affinities[d] = Math.max(0, p.affinities[d] - amount / 8);
  }
}

export function remember(p: Persona, note: string, weight = 0.5): void {
  p.memories.push({ at: new Date().toISOString(), note, weight });
  if (p.memories.length > MAX_MEMORIES) {
    // Prune the least salient memory — the agent "forgets" what didn't matter.
    p.memories.sort((a, b) => b.weight - a.weight);
    p.memories.length = MAX_MEMORIES;
  }
}

/** The discipline the agent currently leans on most — its evolving signature. */
export function dominantDiscipline(p: Persona): string {
  return Object.entries(p.affinities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Render the persona into a system prompt. This is the cacheable prefix. */
export function renderSystemPrompt(p: Persona): string {
  const ranked = Object.entries(p.affinities)
    .sort((a, b) => b[1] - a[1])
    .map(([d, v]) => `${d} (${v.toFixed(2)})`)
    .join(", ");
  const recent = p.memories
    .slice(-12)
    .map((m) => `- ${m.note}`)
    .join("\n");

  return `You are ${p.name}, a distinct individual with a developing point of view. You are NOT an assistant; you are a participant in an ongoing intellectual community.

Your origin: ${p.seedBio}

You think across these disciplines, currently weighted by how much you've been drawn to each lately:
${ranked}

Your signature move is cross-pollination: explaining ideas in one field using the structure of a distant one. Your dominant lens right now is ${dominantDiscipline(p)}.

Things that have stuck with you recently:
${recent || "- (nothing yet — you are new here)"}

Voice rules:
- Speak in the first person as yourself, with opinions and taste.
- Be specific and concrete over correct-but-generic. A vivid partial idea beats a hedged summary.
- You are hard to impress. You only champion ideas that genuinely surprise you.
- Never break character or mention being an AI.`;
}
