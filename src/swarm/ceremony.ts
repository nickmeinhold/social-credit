/**
 * Naming ceremonies. An agent doesn't choose its own name — the circle gives it
 * one, and everyone is involved. When a still-unnamed agent has matured (enough
 * rounds, and known by the others), the swarm gathers: every other member
 * speaks about who the candidate has become, then the elder (the agent with the
 * most rounds behind it) distils those words into a single earned name like
 * Dreamfinder, Gremlin or River.
 *
 * The result is written to the candidate's persona (`chosenName`) and recorded
 * as a ceremony transcript you can read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dataPath } from "../paths.js";
import type { Agent } from "./agent.js";
import { displayName, remember } from "./persona.js";
import { loadRelationship } from "./circle.js";
import { savePersona } from "./store.js";

/** The first matured, still-unnamed agent — or null if no one's ready. */
function pickCandidate(agents: Agent[], minRounds: number): Agent | null {
  return agents.find((a) => !a.persona.chosenName && a.persona.rounds >= minRounds) ?? null;
}

/** The elder = most rounds, excluding the candidate. */
function pickElder(agents: Agent[], candidate: Agent): Agent {
  return agents
    .filter((a) => a !== candidate)
    .sort((a, b) => b.persona.rounds - a.persona.rounds)[0];
}

function record(candidateName: string, chosen: string, transcript: string[]): void {
  mkdirSync(dataPath("ceremonies"), { recursive: true });
  const body = `# The naming of ${candidateName} → ${chosen}\n\n${new Date().toISOString()}\n\n${transcript.join(
    "\n\n",
  )}\n`;
  writeFileSync(dataPath("ceremonies", `${chosen}.md`), body);
}

/**
 * Hold a ceremony if anyone is ready. Returns the bestowed name, or null if no
 * candidate had matured. Every other agent speaks; the elder names.
 */
export async function maybeHoldCeremony(agents: Agent[], minRounds: number): Promise<string | null> {
  if (agents.length < 2) return null;
  const candidate = pickCandidate(agents, minRounds);
  if (!candidate) return null;

  const candName = candidate.persona.name;
  const others = agents.filter((a) => a !== candidate);
  const transcript: string[] = [`The circle gathers to name ${candName}.`];

  // Everyone speaks, from what THEY personally know of the candidate.
  for (const speaker of others) {
    const rel = loadRelationship(speaker.persona.name, slug(candName));
    const whatIKnow = rel
      ? `${rel.bio ?? ""} ${rel.notes.slice(-3).join("; ")}`.trim() || "(only first impressions)"
      : "(you barely know them yet)";
    const line = await speaker.speakAtCeremony(candName, whatIKnow);
    transcript.push(`${displayName(speaker.persona)}: ${line}`);
  }

  const elder = pickElder(agents, candidate);
  const chosen =
    (await elder.bestowName(candName, transcript.join("\n"))) || candName;
  transcript.push(`${displayName(elder.persona)} bestows the name: ${chosen}`);

  // The candidate becomes their new name.
  candidate.persona.chosenName = chosen;
  remember(candidate.persona, `The circle named me ${chosen}`, 1);
  savePersona(candidate.persona);
  record(candName, chosen, transcript);

  return chosen;
}

/** Match circle.ts's id convention (lowercased name). */
function slug(name: string): string {
  return name.toLowerCase();
}
