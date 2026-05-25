/**
 * The INTERNAL-circle engagement surface: starring a circle member's GitHub
 * repo AS THE USER.
 *
 * We shell out to the `gh` CLI rather than hand-rolling an authenticated HTTP
 * client, for the same reason the rest of the project leans on platform-native
 * APIs: `gh` already holds the user's auth (and in CI, the workflow's
 * GITHUB_TOKEN), handles the REST plumbing, and is the officially-blessed path.
 * The endpoint is `PUT /user/starred/{owner}/{repo}`.
 *
 * Like every other outward action in this project, this is only ever called
 * AFTER the engagement policy gate says "ok" — never directly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** True if a string looks like a "owner/repo" slug we can safely pass to gh. */
export function isRepoSlug(s: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}

/**
 * Star `owner/repo` for the authenticated user via `gh api`. Throws if the slug
 * is malformed (defensive: it's interpolated into a shell-exec'd path) or if
 * `gh` returns non-zero. Returns the slug on success.
 */
export async function starRepo(slug: string): Promise<string> {
  if (!isRepoSlug(slug)) throw new Error(`Refusing to star malformed repo slug: ${slug}`);
  // PUT /user/starred/{owner}/{repo} — idempotent: starring an already-starred
  // repo is a no-op 204, so a retry can't double-anything.
  await run("gh", ["api", "--method", "PUT", `/user/starred/${slug}`]);
  return slug;
}
