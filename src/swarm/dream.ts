/**
 * Dreams: each agent reflects on recent life and the people in its circle, then
 * those reflections feed back into its relationship graph and memory. This is
 * the loop that makes "gradually get to know everyone" literally true — every
 * dream sharpens the agent's view of the humans and agents around it.
 *
 * Deliberately NOT surreal and NOT mortal: no dream-logic, no self-deletion.
 * Grounded reflection about real posts and real people.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dataPath, DATA_DIR } from "../paths.js";
import type { Agent } from "./agent.js";
import { displayName, remember } from "./persona.js";
import { applyUpdate, summariseCircle, type RelationshipUpdate } from "./circle.js";
import { savePersona } from "./store.js";

interface DreamPayload {
  updates: RelationshipUpdate[];
  curiosities: string[];
}

/** Pull the prose journal and the trailing JSON block apart. */
function parseDream(raw: string): { journal: string; payload: DreamPayload } {
  const fence = raw.match(/```json\s*([\s\S]*?)```/);
  let payload: DreamPayload = { updates: [], curiosities: [] };
  if (fence) {
    try {
      const o = JSON.parse(fence[1]);
      payload = { updates: o.updates ?? [], curiosities: o.curiosities ?? [] };
    } catch {
      /* a malformed block just means no structured updates this dream */
    }
  }
  const journal = raw.replace(/```json[\s\S]*?```/, "").trim();
  return { journal, payload };
}

function appendJournal(agentName: string, displayedName: string, journal: string): void {
  const dir = dataPath("dreams");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const entry = `\n## ${displayedName} — ${stamp}\n\n${journal}\n`;
  writeFileSync(dataPath("dreams", `${agentName}.md`), entry, { flag: "a" });
}

/** Run one agent's dream: reflect, journal it, and update its circle + memory. */
export async function dreamOne(agent: Agent, ownerName: string, recent: string): Promise<void> {
  const name = agent.persona.name;
  const raw = await agent.dream({
    ownerName,
    circleSummary: summariseCircle(name),
    recent,
  });
  const { journal, payload } = parseDream(raw);

  appendJournal(name, displayName(agent.persona), journal);
  for (const u of payload.updates) applyUpdate(name, u);
  for (const c of payload.curiosities) remember(agent.persona, `Curious: ${c}`, 0.6);
  remember(agent.persona, `Dreamt and reflected on the circle`, 0.4);
  savePersona(agent.persona);
}

export { DATA_DIR };
