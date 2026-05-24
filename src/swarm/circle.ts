/**
 * "The circle" — each agent's SUBJECTIVE model of everyone it knows.
 *
 * Crucially, relationships are stored per-agent (data/relationships/<agent>/),
 * so two agents can feel differently about the same human. This is what gives
 * the swarm divergent inner lives: River can warm to your human while Gremlin
 * stays prickly, because each keeps its own notes and sentiment.
 *
 * Humans are seeded from the `circle` config block; the other agents are added
 * automatically so everyone knows everyone. Dreams write to these records,
 * ceremonies read from them, emails act on them.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, dataPath } from "../paths.js";

export interface Person {
  id: string;
  name: string;
  kind: "human" | "agent";
  email?: string;
  /** Optional GitHub repo for the PR feature (circle members can read it). */
  repo?: string;
}

export interface Relationship extends Person {
  /** A seed line, then accumulated observations from dreams/interactions. */
  bio?: string;
  notes: string[];
  /** -1 (dislike) .. 1 (like). Starts neutral, drifts with experience. */
  sentiment: number;
  /** What this person seems to care about, learned over time. */
  topics: string[];
  interactions: number;
  lastEmailedAt?: string;
}

const MAX_NOTES = 25;
const relDir = (agent: string) => dataPath("relationships", agent);

function relFile(agent: string, personId: string) {
  return join(relDir(agent), `${personId}.json`);
}

export function loadRelationship(agent: string, personId: string): Relationship | null {
  const f = relFile(agent, personId);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Relationship) : null;
}

export function saveRelationship(agent: string, rel: Relationship): void {
  mkdirSync(relDir(agent), { recursive: true });
  writeFileSync(relFile(agent, rel.id), JSON.stringify(rel, null, 2));
}

export function loadCircle(agent: string): Relationship[] {
  const dir = relDir(agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Relationship);
}

/** Create a neutral relationship from a Person seed if one doesn't exist yet. */
export function meet(agent: string, p: Person & { bio?: string }): Relationship {
  const existing = loadRelationship(agent, p.id);
  if (existing) return existing;
  const rel: Relationship = {
    ...p,
    bio: p.bio,
    notes: [],
    sentiment: 0,
    topics: [],
    interactions: 0,
  };
  saveRelationship(agent, rel);
  return rel;
}

export interface RelationshipUpdate {
  person: string; // person id
  note?: string;
  /** Clamped contribution to sentiment, e.g. -0.3..0.3. */
  sentimentDelta?: number;
  topics?: string[];
}

/** Merge a dream's observations into an agent's view of someone. */
export function applyUpdate(agent: string, u: RelationshipUpdate): void {
  const rel = loadRelationship(agent, u.person);
  if (!rel) return; // we don't fabricate people we've never met
  if (u.note) {
    rel.notes.push(u.note);
    if (rel.notes.length > MAX_NOTES) rel.notes = rel.notes.slice(-MAX_NOTES);
  }
  if (typeof u.sentimentDelta === "number") {
    rel.sentiment = Math.max(-1, Math.min(1, rel.sentiment + clamp(u.sentimentDelta, -0.3, 0.3)));
  }
  if (u.topics?.length) rel.topics = [...new Set([...rel.topics, ...u.topics])].slice(0, 20);
  rel.interactions += 1;
  saveRelationship(agent, rel);
}

/** A compact, human-readable summary of how an agent sees its circle. */
export function summariseCircle(agent: string): string {
  const circle = loadCircle(agent);
  if (!circle.length) return "(you don't know anyone yet)";
  return circle
    .map((r) => {
      const feel = r.sentiment > 0.2 ? "warm to" : r.sentiment < -0.2 ? "wary of" : "neutral on";
      const recent = r.notes.slice(-2).join("; ");
      return `- ${r.name} (${r.kind}, id:${r.id}) — you're ${feel} them${
        r.topics.length ? `, cares about ${r.topics.slice(0, 4).join(", ")}` : ""
      }${recent ? `. Lately: ${recent}` : ""}`;
    })
    .join("\n");
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export { DATA_DIR };
