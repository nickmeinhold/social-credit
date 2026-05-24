/**
 * Persistence for the swarm. Plain JSON files under `data/` — no database,
 * because the whole point is that this runs as a personal daemon you can read,
 * diff and back up by hand. Each agent is one file so personalities are easy to
 * inspect and you can watch them drift over time with `git diff` if you want.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, dataPath } from "../paths.js";
import type { Persona } from "./persona.js";

const AGENTS_DIR = dataPath("agents");

function ensureDirs() {
  mkdirSync(AGENTS_DIR, { recursive: true });
}

export function savePersona(p: Persona): void {
  ensureDirs();
  writeFileSync(join(AGENTS_DIR, `${p.name}.json`), JSON.stringify(p, null, 2));
}

export function loadPersona(name: string): Persona | null {
  const f = join(AGENTS_DIR, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Persona) : null;
}

export function loadAllPersonas(): Persona[] {
  ensureDirs();
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(AGENTS_DIR, f), "utf8")) as Persona);
}

/** Append a line to the arena transcript so you can read what the swarm said. */
export function appendTranscript(line: string): void {
  ensureDirs();
  writeFileSync(join(DATA_DIR, "transcript.log"), `${line}\n`, { flag: "a" });
}
