/**
 * The PR proposer: how an agent goes from "I read a repo" to "I opened a PR".
 *
 * Two halves, split exactly like mailer.ts splits drafting from sending:
 *
 *  - `proposePR()` is the REASONING half. It reads a target repo's surface
 *    (README + tree via the `gh` CLI), asks the agent to reason about ONE
 *    small, useful, reviewable change, and returns a draft. No side effects.
 *
 *  - `openPR()` is the IRREVERSIBLE half. It clones the repo to a temp dir,
 *    writes the proposed file changes, branches, commits, pushes, and runs
 *    `gh pr create`. Every PR body is stamped with an authorship-disclosure
 *    footer so a human reviewer always knows an AI agent opened it.
 *
 * Both gates (allowlist + approval) live in bridge/prs.ts; by the time openPR
 * runs, the item is already allowlisted (checked at enqueue) and approved
 * (checked by the daemon before flush). This module assumes neither and so
 * re-checks the allowlist defensively before doing anything outward.
 *
 * `gh` and `node:child_process` are reached for lazily so a fork that never
 * enables agentPRs pays nothing and the module loads without `gh` installed.
 */
import type { Config } from "../config.js";
import type { Agent } from "./agent.js";
import { displayName } from "./persona.js";
import { isRepoAllowed, type PRChange, type PRItem } from "../bridge/prs.js";

/** The disclosure footer stamped on every PR body. GitHub's abuse policy and
 *  basic honesty both demand a human reviewer know an AI agent authored this. */
export function disclosureFooter(agentName: string): string {
  return [
    "",
    "---",
    `_This pull request was proposed autonomously by **${agentName}**, an AI agent in a`,
    "[social-credit](https://github.com/nickmeinhold/social-credit) swarm, and opened on its",
    "owner's behalf. It was held for human approval before opening. Review it as you would any",
    "other contribution; close it freely if it isn't useful._",
  ].join("\n");
}

/** Wrap a body with the disclosure footer (idempotent-ish: only adds once). */
export function withDisclosure(body: string, agentName: string): string {
  return body.includes("proposed autonomously by") ? body : body + "\n" + disclosureFooter(agentName);
}

/** Read a target repo's surface for the agent to reason over. Lazy `gh`. */
async function readRepoSurface(repo: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const parts: string[] = [];
  // README (best-effort) — the single richest signal of what a repo is for.
  try {
    const { stdout } = await run("gh", ["api", `repos/${repo}/readme`, "-q", ".content"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    parts.push("README:\n" + Buffer.from(stdout.trim(), "base64").toString("utf8").slice(0, 4000));
  } catch {
    parts.push("README: (none or unreadable)");
  }
  // Top-level file listing — enough to suggest a plausible, scoped change.
  try {
    const { stdout } = await run(
      "gh",
      ["api", `repos/${repo}/contents`, "-q", ".[].path"],
      { maxBuffer: 1024 * 1024 },
    );
    parts.push("Top-level files:\n" + stdout.trim());
  } catch {
    parts.push("Top-level files: (unreadable)");
  }
  return parts.join("\n\n");
}

export interface ProposedDraft {
  fromAgent: string;
  repo: string;
  branch: string;
  title: string;
  body: string;
  changes: PRChange[];
}

/**
 * Have an agent read an allowlisted repo and reason about ONE small change.
 * Returns a draft (NOT yet queued) or null if the agent declines / the model
 * output is unusable. Throws if the repo is off-allowlist — reasoning about a
 * forbidden target is itself out of bounds.
 */
export async function proposePR(agent: Agent, repo: string, cfg: Config): Promise<ProposedDraft | null> {
  if (!isRepoAllowed(repo, cfg)) {
    throw new Error(`refusing to read off-allowlist repo "${repo}"`);
  }
  const surface = await readRepoSurface(repo);
  const agentName = displayName(agent.persona);

  // Ask the agent (in persona) for a strict-JSON proposal so the daemon gets a
  // clean, bounded change set.
  const raw = await agent.reason(
    `You're looking at the repo "${repo}". Here is its surface:\n\n${surface}\n\n` +
      `Propose ONE small, genuinely useful, easily-reviewable change (a typo fix, a clarifying ` +
      `README line, a tiny doc improvement). Keep it minimal and respectful — this opens a real PR ` +
      `on someone's repo. If nothing is worth proposing, say so.\n\n` +
      `Reply ONLY as JSON:\n` +
      `{"propose": <true|false>, "title": "<pr title>", "body": "<pr body, markdown>", ` +
      `"changes": [{"path": "<file>", "content": "<FULL new file contents>"}]}`,
    { temperature: 0.5, maxTokens: 1500 },
  );

  const parsed = safeParseProposal(raw);
  if (!parsed || !parsed.propose || !parsed.changes.length || !parsed.title) return null;

  const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return {
    fromAgent: agentName,
    repo,
    branch: `sc/${agentName.toLowerCase()}-${slug || "change"}`,
    title: parsed.title.slice(0, 120),
    body: withDisclosure(parsed.body || parsed.title, agentName),
    changes: parsed.changes.slice(0, 10),
  };
}

/**
 * Open an approved, allowlisted PR for real. Defensive re-check of the
 * allowlist, then clone -> write -> branch -> push -> `gh pr create`. Returns
 * the PR URL. The caller (daemon) records it via setPRStatus(opened) so the
 * terminal guard prevents a second open.
 */
export async function openPR(item: PRItem, cfg: Config): Promise<string> {
  if (!cfg.agentPRs?.enabled) throw new Error("agentPRs is disabled");
  if (!isRepoAllowed(item.repo, cfg)) {
    throw new Error(`refusing to open PR against off-allowlist repo "${item.repo}"`);
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const run = promisify(execFile);

  const dir = mkdtempSync(join(tmpdir(), "sc-pr-"));
  const opts = { cwd: dir, maxBuffer: 8 * 1024 * 1024 };

  // Clone via gh so it uses the authenticated user's credentials.
  await run("gh", ["repo", "clone", item.repo, dir, "--", "--depth", "1"], { maxBuffer: 8 * 1024 * 1024 });
  await run("git", ["checkout", "-b", item.branch], opts);

  for (const c of item.changes) {
    const full = join(dir, c.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c.content);
  }

  await run("git", ["add", "-A"], opts);
  await run(
    "git",
    [
      "-c",
      "user.name=social-credit agent",
      "-c",
      "user.email=noreply@github.com",
      "commit",
      "-m",
      `${item.title}\n\nProposed autonomously by ${item.fromAgent} (social-credit agent).`,
    ],
    opts,
  );
  await run("git", ["push", "-u", "origin", item.branch], opts);

  const { stdout } = await run(
    "gh",
    ["pr", "create", "--repo", item.repo, "--head", item.branch, "--title", item.title, "--body", item.body],
    opts,
  );
  // gh prints the PR URL on success.
  return stdout.trim().split(/\s+/).find((t) => t.startsWith("http")) ?? stdout.trim();
}

function safeParseProposal(
  raw: string,
): { propose: boolean; title: string; body: string; changes: PRChange[] } | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : raw);
    const changes: PRChange[] = Array.isArray(o.changes)
      ? o.changes
          .filter((c: unknown) => c && typeof (c as PRChange).path === "string")
          .map((c: PRChange) => ({ path: String(c.path), content: String(c.content ?? "") }))
      : [];
    return {
      propose: Boolean(o.propose),
      title: String(o.title ?? ""),
      body: String(o.body ?? ""),
      changes,
    };
  } catch {
    return null;
  }
}
