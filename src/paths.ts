/**
 * Where runtime state lives. Overridable via SC_DATA_DIR so CI can point it at a
 * checkout of the `swarm-state` branch — the daemon writes here, the workflow
 * commits it back, and personalities persist across otherwise-stateless runs.
 */
import { join } from "node:path";

export const DATA_DIR = process.env.SC_DATA_DIR ?? "data";

export const dataPath = (...parts: string[]): string => join(DATA_DIR, ...parts);
