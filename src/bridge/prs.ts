/**
 * The agent-PR sink + its allowlist + its human-in-the-loop queue.
 *
 * This is the deliberate sibling of bridge/mailer.ts, and the most
 * abuse-sensitive module in the codebase. Agents read repos, reason, and
 * propose pull requests. A PR speaks OUTWARD to a real repo on the owner's
 * GitHub account, so two gates protect that account from being flagged for
 * spam — and BOTH are non-negotiable per GitHub's abuse policy:
 *
 *   1. ALLOWLIST. An agent may only target a repo that is either a circle
 *      member's repo (the `repo` field on a `Person`, src/swarm/circle.ts) or
 *      an owner-designated repo in `agentPRs.allowlist`. There is NEVER an open
 *      firehose: an off-allowlist repo is rejected at enqueue time.
 *
 *   2. APPROVAL. Every proposed PR lands "pending" and a human approves before
 *      the next flush opens it for real. `agentPRs.autoOpen` relaxes this to
 *      born-"approved" — but ONLY within the allowlist; it never widens what
 *      may be targeted.
 *
 * Opening a real PR is irreversible, so the status machine makes `opened`
 * terminal (mirroring `sent` in mailer.ts): you cannot re-approve an opened
 * proposal and have the next flush open a duplicate PR against a real repo.
 *
 * The queue is one JSON file (`data/prs.json`) you can inspect/edit by hand,
 * exactly like the post and email queues. Opening uses the `gh` CLI, imported
 * lazily by the proposer so a fork that never enables this pays nothing.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { DATA_DIR, dataPath } from "../paths.js";
import type { Config } from "../config.js";

export type PRStatus = "pending" | "approved" | "opened" | "rejected";

const PR_STATUSES = ["pending", "approved", "opened", "rejected"] as const;

/** Narrow an untrusted string (e.g. a CLI arg) to a PRStatus, or undefined if
 *  it isn't a valid status. Avoids `as any` casts on the CLI boundary. */
export function parsePRStatus(s: string | undefined): PRStatus | undefined {
  return s && (PR_STATUSES as readonly string[]).includes(s) ? (s as PRStatus) : undefined;
}

/** A single file change the PR will make. Kept tiny — agents propose small,
 *  reviewable diffs, not sweeping rewrites. */
export interface PRChange {
  path: string;
  /** Full new contents of the file (the proposer writes this verbatim). */
  content: string;
}

export interface PRItem {
  id: string;
  createdAt: string;
  /** Display name of the agent that proposed it. */
  fromAgent: string;
  /** Target repo as "owner/name". MUST be on the allowlist. */
  repo: string;
  /** Branch the proposer will push the changes to. */
  branch: string;
  title: string;
  /** PR body. The proposer stamps an authorship-disclosure footer on top. */
  body: string;
  changes: PRChange[];
  status: PRStatus;
  openedAt?: string;
  prUrl?: string;
  error?: string;
}

const PR_FILE = () => dataPath("prs.json");

function read(): PRItem[] {
  if (!existsSync(PR_FILE())) return [];
  return JSON.parse(readFileSync(PR_FILE(), "utf8")) as PRItem[];
}
function write(items: PRItem[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PR_FILE(), JSON.stringify(items, null, 2));
}

/** Normalise a repo slug for comparison: trim, drop a trailing .git, lowercase.
 *  GitHub repo names are case-insensitive, so the allowlist is too. */
function normaliseRepo(repo: string): string {
  return repo.trim().replace(/\.git$/i, "").toLowerCase();
}

/**
 * The set of repos an agent may target, as normalised slugs: every circle
 * member's `repo` plus the owner-designated `agentPRs.allowlist`. This is the
 * single source of truth for "what's allowed" — both the enqueue guard and any
 * read-before-PR step should consult it.
 */
export function allowedRepos(cfg: Config): Set<string> {
  const repos = new Set<string>();
  for (const p of cfg.circle ?? []) {
    if (p.repo) repos.add(normaliseRepo(p.repo));
  }
  for (const r of cfg.agentPRs?.allowlist ?? []) {
    if (r) repos.add(normaliseRepo(r));
  }
  return repos;
}

/** True iff `repo` is on the allowlist. Off-allowlist repos are rejected. */
export function isRepoAllowed(repo: string, cfg: Config): boolean {
  return allowedRepos(cfg).has(normaliseRepo(repo));
}

/**
 * Resolve a proposed change path INSIDE a clone dir, refusing anything that
 * would escape it or touch repo internals. The `path` on a `PRChange` comes
 * from parsed LLM output, so it is hostile input: a hallucinating or adversarial
 * model could emit `../../../../etc/passwd`, an absolute path, or `.git/config`
 * to achieve an arbitrary local file write or to rewrite git's own state. We
 * resolve against `repoDir` and require the result to stay strictly within it,
 * and we forbid writes into a `.git` segment. Returns the safe absolute path;
 * throws on any escape attempt.
 */
export function safeChangePath(repoDir: string, changePath: string): string {
  const base = resolve(repoDir);
  const full = resolve(base, changePath);
  // Must be base itself's child: prefix with the separator so "/repo-evil" can't
  // pass a naive startsWith("/repo") check.
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`illegal change path escapes the repo: ${changePath}`);
  }
  // Never let an agent write into git's own metadata.
  const rel = full.slice(base.length + 1);
  if (rel === ".git" || rel.startsWith(".git" + sep)) {
    throw new Error(`illegal change path targets .git: ${changePath}`);
  }
  return full;
}

/**
 * Queue a proposed PR. Throws if agentPRs is disabled, or if the target repo
 * is off the allowlist — the gate is enforced here, not only at flush time, so
 * a bad target never even reaches the queue. Born "approved" only when
 * `autoOpen` is on AND the repo is allowlisted; else "pending".
 */
export function enqueuePR(
  draft: Omit<PRItem, "id" | "createdAt" | "status">,
  cfg: Config,
  autoOpen: boolean,
): PRItem {
  if (!cfg.agentPRs?.enabled) {
    throw new Error("agentPRs is disabled (cfg.agentPRs.enabled is false)");
  }
  if (!isRepoAllowed(draft.repo, cfg)) {
    throw new Error(
      `repo "${draft.repo}" is not on the allowlist (circle-member repos + agentPRs.allowlist only)`,
    );
  }
  const items = read();
  const item: PRItem = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: autoOpen ? "approved" : "pending",
    ...draft,
  };
  items.push(item);
  write(items);
  return item;
}

export function listPRs(status?: PRStatus): PRItem[] {
  const items = read();
  return status ? items.filter((i) => i.status === status) : items;
}

/**
 * Legal status transitions. Opening a real PR is irreversible, so `opened` and
 * `rejected` are terminal — you cannot re-`approve` an `opened` proposal and
 * have the next flush open it a second time against a real repo. A same-state
 * write (e.g. approved->approved to record a transient open error) is allowed.
 */
const ALLOWED_TRANSITIONS: Record<PRStatus, PRStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["opened", "rejected"],
  opened: [],
  rejected: [],
};

export function setPRStatus(id: string, status: PRStatus, patch?: Partial<PRItem>): void {
  const items = read();
  const it = items.find((i) => i.id === id);
  if (!it) throw new Error(`No PR ${id}`);
  if (it.status !== status && !ALLOWED_TRANSITIONS[it.status].includes(status)) {
    throw new Error(
      `Illegal PR transition ${it.status} -> ${status} for ${id} (an opened PR cannot be re-opened)`,
    );
  }
  it.status = status;
  if (patch) Object.assign(it, patch);
  write(items);
}
