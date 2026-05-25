/**
 * Tests for the agent-PR queue — the abuse-sensitive part of the codebase.
 *
 * Two properties matter most and neither is reachable by eyeballing:
 *
 *  1. ALLOWLIST: an agent may only open a PR against a circle member's repo or
 *     an owner-designated repo. An off-allowlist repo is rejected. Autonomous
 *     PRs across arbitrary repos is exactly the spam pattern that flags the
 *     owner's GitHub account, so this is the load-bearing gate.
 *
 *  2. IRREVERSIBLE STATE: opening a real PR can't be undone, so `opened` is
 *     terminal — you cannot re-approve an opened proposal and have the next
 *     flush open a second duplicate PR against a real repo.
 *
 * The queue does file I/O keyed off SC_DATA_DIR (read at module load in
 * paths.ts), so we point it at a fresh temp dir and dynamic-import after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SC_DATA_DIR = mkdtempSync(join(tmpdir(), "sc-prs-"));
const { enqueuePR, setPRStatus, listPRs, allowedRepos, isRepoAllowed } = await import("./prs.js");

function draft() {
  return {
    fromAgent: "Umbra",
    repo: "robin/robin-blog",
    title: "Fix a typo in the README",
    body: "A small fix.",
    branch: "sc/umbra-readme-typo",
    changes: [{ path: "README.md", content: "# Hello\n" }],
  };
}

// A minimal config the allowlist functions can read. Only the fields they touch.
function cfg(over: Partial<any> = {}): any {
  return {
    circle: [
      { id: "robin", name: "Robin", kind: "human", repo: "robin/robin-blog" },
      { id: "noa", name: "Noa", kind: "human" }, // no repo -> not allowlisted
    ],
    agentPRs: { enabled: true, allowlist: ["owner/designated-repo"], autoOpen: false },
    ...over,
  };
}

// --- ALLOWLIST (the whole point) -------------------------------------------

test("allowedRepos unions circle-member repos with owner-designated allowlist", () => {
  const repos = allowedRepos(cfg());
  assert.ok(repos.has("robin/robin-blog"), "circle member's repo is allowed");
  assert.ok(repos.has("owner/designated-repo"), "owner-designated repo is allowed");
});

test("a circle member without a repo contributes nothing to the allowlist", () => {
  const repos = allowedRepos(cfg());
  assert.equal([...repos].length, 2);
});

test("isRepoAllowed accepts an allowlisted repo (case-insensitive)", () => {
  assert.equal(isRepoAllowed("robin/robin-blog", cfg()), true);
  assert.equal(isRepoAllowed("Robin/Robin-Blog", cfg()), true);
});

test("isRepoAllowed REJECTS an off-allowlist repo (no open firehose)", () => {
  assert.equal(isRepoAllowed("stranger/private-repo", cfg()), false);
  assert.equal(isRepoAllowed("torvalds/linux", cfg()), false);
});

test("enqueuePR rejects an off-allowlist repo at enqueue time", () => {
  assert.throws(
    () => enqueuePR({ ...draft(), repo: "stranger/x" }, cfg(), false),
    /not on the allowlist/,
  );
});

test("enqueuePR rejects when agentPRs is disabled even for an allowlisted repo", () => {
  assert.throws(
    () => enqueuePR(draft(), cfg({ agentPRs: { enabled: false, allowlist: [], autoOpen: false } }), false),
    /agentPRs is disabled/,
  );
});

// --- APPROVAL GATING --------------------------------------------------------

test("a proposed PR is born pending by default (approval-gated)", () => {
  const item = enqueuePR(draft(), cfg(), false);
  assert.equal(item.status, "pending");
});

test("autoOpen lets an allowlisted PR be born approved", () => {
  const item = enqueuePR(draft(), cfg(), true);
  assert.equal(item.status, "approved");
});

// --- IRREVERSIBLE STATE MACHINE --------------------------------------------

test("pending -> approved -> opened is the happy path", () => {
  const item = enqueuePR(draft(), cfg(), false);
  setPRStatus(item.id, "approved");
  setPRStatus(item.id, "opened", { prUrl: "https://github.com/robin/robin-blog/pull/1" });
  const found = listPRs("opened").find((p) => p.id === item.id);
  assert.equal(found?.status, "opened");
  assert.equal(found?.prUrl, "https://github.com/robin/robin-blog/pull/1");
});

test("an opened PR cannot be re-approved (no duplicate PR against a real repo)", () => {
  const item = enqueuePR(draft(), cfg(), true); // born approved
  setPRStatus(item.id, "opened");
  assert.throws(() => setPRStatus(item.id, "approved"), /Illegal PR transition/);
});

test("a pending PR cannot jump straight to opened (must be approved first)", () => {
  const item = enqueuePR(draft(), cfg(), false);
  assert.throws(() => setPRStatus(item.id, "opened"), /Illegal PR transition/);
});

test("a rejected PR is terminal", () => {
  const item = enqueuePR(draft(), cfg(), false);
  setPRStatus(item.id, "rejected");
  assert.throws(() => setPRStatus(item.id, "approved"), /Illegal PR transition/);
});

test("same-state write is allowed (recording a transient open error keeps it approved)", () => {
  const item = enqueuePR(draft(), cfg(), true);
  setPRStatus(item.id, "approved", { error: "gh api 502" });
  const found = listPRs("approved").find((p) => p.id === item.id);
  assert.equal(found?.error, "gh api 502");
});
