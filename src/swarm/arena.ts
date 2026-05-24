/**
 * The arena runs one "round" of social life for the swarm:
 *   1. Pick a topic (seeded from recent content if available).
 *   2. A few agents take turns speaking — a real back-and-forth thread.
 *   3. Each agent privately rates the most interesting thing it encountered.
 *   4. Agents that rated something at/above the boost threshold "boost" it, and
 *      one inspired agent may compose original content.
 *
 * The round returns Boosts and Drafts; the daemon/bridge decides what (if
 * anything) reaches a real platform. The arena itself never touches the network.
 */
import type { Config } from "../config.js";
import type { LLM } from "../llm/types.js";
import { Agent } from "./agent.js";
import { savePersona, appendTranscript } from "./store.js";
import { dominantDiscipline } from "./persona.js";

export interface Boost {
  agent: string;
  score: number;
  reason: string;
  target: { title?: string; text: string; link?: string };
}

export interface Draft {
  /** "original" = agent-written; "boost" = endorsement of existing content. */
  kind: "original" | "boost";
  author: string;
  text: string;
  link?: string;
}

/** A candidate the swarm reacts to — e.g. one of the user's own blog posts. */
export interface Candidate {
  title?: string;
  text: string;
  link?: string;
}

function sample<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

export async function runRound(
  cfg: Config,
  llm: LLM,
  agents: Agent[],
  candidates: Candidate[],
): Promise<{ boosts: Boost[]; drafts: Draft[] }> {
  const boosts: Boost[] = [];
  const drafts: Draft[] = [];
  if (agents.length === 0) return { boosts, drafts };

  // 1. Topic: a candidate's title, else a discipline mash-up from the swarm.
  const speakers = sample(agents, Math.min(3, agents.length));
  const topic =
    candidates[0]?.title ??
    `Where does ${dominantDiscipline(speakers[0].persona)} meet ${dominantDiscipline(
      speakers[speakers.length - 1].persona,
    )}?`;

  appendTranscript(`\n=== round @ ${new Date().toISOString()} — topic: ${topic} ===`);

  // 2. Discussion thread.
  const thread: string[] = [];
  for (const a of speakers) {
    const line = await a.speak(topic, thread);
    const entry = `${a.persona.name}: ${line}`;
    thread.push(entry);
    appendTranscript(entry);
  }

  // 3. Ratings + boosts over the user's candidate content.
  for (const cand of candidates) {
    for (const a of sample(agents, Math.min(3, agents.length))) {
      const r = await a.rate(cand);
      if (r.score >= cfg.swarm.boostThreshold) {
        boosts.push({ agent: a.persona.name, score: r.score, reason: r.reason, target: cand });
        drafts.push({
          kind: "boost",
          author: a.persona.name,
          text: `${r.reason}`,
          link: cand.link,
        });
        appendTranscript(`  ★ ${a.persona.name} boosts "${cand.title ?? ""}" (${r.score.toFixed(2)}): ${r.reason}`);
      }
    }
  }

  // 4. One agent may feel inspired enough to write something original.
  const inspired = sample(speakers, 1)[0];
  if (inspired) {
    const original = await inspired.compose(topic);
    drafts.push({ kind: "original", author: inspired.persona.name, text: original });
    appendTranscript(`  ✎ ${inspired.persona.name} composed: ${original}`);
  }

  // Persist evolved personas.
  for (const a of agents) savePersona(a.persona);

  return { boosts, drafts };
}
