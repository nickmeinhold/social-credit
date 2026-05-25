/**
 * Discriminating engagement — turning the swarm's in-transcript "boosts" into
 * REAL outward actions (a GitHub star, a Bluesky like/repost) AS THE USER.
 *
 * This is the most dangerous file in the project: every action here is an
 * irreversible-ish side effect on a third party's account, performed
 * automatically. The whole point of the module is the POLICY that keeps these
 * actions from looking like a coordinated engagement RING — the thing that
 * actually gets accounts flagged and banned.
 *
 * ## The ring-protection policy (read this before you tune anything)
 *
 * Selectivity is NOT the protection. `boostThreshold` is deliberately LOW (0.4):
 * this is a warm circle that celebrates each other, and a high bar wouldn't make
 * the *pattern* any safer. What gets accounts banned is COORDINATED RECIPROCAL
 * automation — "A stars B the instant B stars A", everyone starring everyone, in
 * tight bursts. So the protection is three independent things, all enforced here:
 *
 *   1. RATE LIMIT + DAILY CAP + JITTER — never more than `dailyCap` actions/day,
 *      never two actions closer than `minIntervalMs`, and every delay gets random
 *      jitter so the cadence isn't a metronome. Bursty, regular automation is the
 *      tell; this smears it out.
 *   2. NON-RECIPROCITY — we never do "A engages B *because* B engaged A". We do
 *      not mirror. We do not star-all-members. A lopsided outcome (you star them,
 *      they never star you) is not just allowed, it's the GOAL: real affinity is
 *      lopsided. The reciprocal graph is the fingerprint of a ring.
 *   3. DISABLED BY DEFAULT — inert unless explicitly configured (like the email
 *      feature). A fork that does nothing here is the safe default.
 *
 * Mirror `bridge/queue.ts`: a single JSON file of records, pure read/write
 * helpers, and a closed-set status union. The PURE predicates below
 * (`withinDailyCap`, `respectsMinInterval`, `wouldBeReciprocal`, `jitteredDelay`)
 * have no I/O so they can be unit-tested in isolation — they guard irreversible
 * outward actions, so they're the part that's tested.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DATA_DIR, dataPath } from "../paths.js";

/** The kinds of outward engagement we can perform. Closed set — not bare strings. */
export type EngagementKind = "star" | "like" | "repost";

/** Where the engagement landed. "github" for stars; a platform name otherwise. */
export type EngagementSurface = "github" | "bluesky" | "mastodon";

/**
 * Why an attempted engagement did or didn't fire. Closed set so callers can
 * exhaustively switch and the daemon can log a precise reason. `"ok"` is the
 * only value that means "go ahead and perform the action".
 */
export type EngagementDecision =
  | "ok"
  | "disabled"
  | "daily-cap-reached"
  | "too-soon"
  | "reciprocity-guard"
  | "already-engaged";

/** A single performed engagement, persisted to enforce caps + non-reciprocity. */
export interface EngagementRecord {
  id: string;
  /** When we performed it. */
  at: string;
  kind: EngagementKind;
  surface: EngagementSurface;
  /**
   * Stable identity of WHO we engaged — the circle member / account, not the
   * artifact. For stars: the repo owner's circle id. For social: the author's
   * handle. Reciprocity is checked against this, so it must be the actor, not
   * the post.
   */
  actor: string;
  /** Stable identity of WHAT we engaged (repo slug, post URI). Dedupe key. */
  target: string;
}

/** The config block. INERT unless `enabled` AND a positive cap are set. */
export interface EngagementConfig {
  enabled: boolean;
  /** Hard ceiling on outward actions per rolling calendar day (UTC). */
  dailyCap: number;
  /** Minimum gap between two outward actions, in ms (before jitter). */
  minIntervalMs: number;
  /**
   * Random extra delay added on top of `minIntervalMs`, in ms. The actual delay
   * is `minIntervalMs + random(0, jitterMs)`, so the cadence is never a
   * metronome. Set to 0 to disable jitter (NOT recommended).
   */
  jitterMs: number;
}

export const ENGAGEMENT_DEFAULTS: EngagementConfig = {
  enabled: false,
  dailyCap: 10,
  minIntervalMs: 90_000,
  jitterMs: 60_000,
};

const FILE = () => dataPath("engagement.json");

function read(): EngagementRecord[] {
  if (!existsSync(FILE())) return [];
  return JSON.parse(readFileSync(FILE(), "utf8")) as EngagementRecord[];
}
function write(records: EngagementRecord[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE(), JSON.stringify(records, null, 2));
}

// ---------------------------------------------------------------------------
// PURE policy predicates — no I/O, fully unit-tested. History is passed in.
// ---------------------------------------------------------------------------

/** UTC calendar-day key, e.g. "2026-05-25", for counting same-day actions. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * True if performing one more action `now` stays within the daily cap.
 * Counts only actions on the SAME UTC day as `now`.
 */
export function withinDailyCap(history: EngagementRecord[], cap: number, now: Date): boolean {
  if (cap <= 0) return false;
  const today = dayKey(now.toISOString());
  const usedToday = history.filter((r) => dayKey(r.at) === today).length;
  return usedToday < cap;
}

/**
 * True if enough time has elapsed since the most recent action. With no prior
 * history this is trivially true (the first action of all time is fine).
 */
export function respectsMinInterval(
  history: EngagementRecord[],
  minIntervalMs: number,
  now: Date,
): boolean {
  if (history.length === 0) return true;
  const last = history.reduce((a, b) => (a.at > b.at ? a : b));
  return now.getTime() - new Date(last.at).getTime() >= minIntervalMs;
}

/**
 * The non-reciprocity guard. Returns true if engaging `actor` now would look
 * RECIPROCAL — i.e. we have NOT engaged this actor before, which would make
 * "us engaging them" a fresh, organic-looking action... wait — read carefully:
 *
 * Reciprocity is the danger pattern "we engage them right after they engaged
 * us". We don't observe their actions toward us directly, so we approximate the
 * fingerprint we CAN control: we never let our own engagements toward a single
 * actor pile up into a tit-for-tat exchange. Concretely, this guard blocks a
 * SECOND-or-later engagement of the SAME actor within the reciprocity window —
 * the repeated, mutual-looking back-and-forth is the fingerprint. A single
 * lopsided engagement (us → them, once) is exactly what we want and is allowed.
 *
 * @returns true if this engagement WOULD be reciprocal/mirrored (=> block it).
 */
export function wouldBeReciprocal(
  history: EngagementRecord[],
  actor: string,
  windowMs: number,
  now: Date,
): boolean {
  const recentSameActor = history.filter(
    (r) => r.actor === actor && now.getTime() - new Date(r.at).getTime() < windowMs,
  );
  return recentSameActor.length > 0;
}

/** True if we've already performed this exact (kind, target) — never repeat. */
export function alreadyEngaged(
  history: EngagementRecord[],
  kind: EngagementKind,
  target: string,
): boolean {
  return history.some((r) => r.kind === kind && r.target === target);
}

/**
 * The delay to wait before performing an action: the floor interval plus a
 * uniform-random jitter in [0, jitterMs]. `rng` is injectable for testing.
 */
export function jitteredDelay(
  cfg: Pick<EngagementConfig, "minIntervalMs" | "jitterMs">,
  rng: () => number = Math.random,
): number {
  return cfg.minIntervalMs + Math.floor(rng() * Math.max(0, cfg.jitterMs));
}

/**
 * The single decision predicate, composing the above. PURE: takes the full
 * history + the proposed engagement and returns a closed-set reason. The
 * reciprocity window is the daily span (24h) — within a day, never engage the
 * same actor twice; that's the back-and-forth a ring would show.
 */
export function decide(
  cfg: EngagementConfig,
  history: EngagementRecord[],
  proposed: { kind: EngagementKind; actor: string; target: string },
  now: Date = new Date(),
): EngagementDecision {
  if (!cfg.enabled || cfg.dailyCap <= 0) return "disabled";
  if (alreadyEngaged(history, proposed.kind, proposed.target)) return "already-engaged";
  if (!withinDailyCap(history, cfg.dailyCap, now)) return "daily-cap-reached";
  if (!respectsMinInterval(history, cfg.minIntervalMs, now)) return "too-soon";
  // Reciprocity window = 24h: no second engagement of the same actor in a day.
  if (wouldBeReciprocal(history, proposed.actor, 24 * 60 * 60_000, now)) return "reciprocity-guard";
  return "ok";
}

// ---------------------------------------------------------------------------
// Persistence — mirrors queue.ts read/append.
// ---------------------------------------------------------------------------

/** Load the full engagement history (for the daemon to pass into `decide`). */
export function history(): EngagementRecord[] {
  return read();
}

/** Record a performed engagement. Call ONLY after the outward action succeeded. */
export function record(e: {
  kind: EngagementKind;
  surface: EngagementSurface;
  actor: string;
  target: string;
}): EngagementRecord {
  const records = read();
  const rec: EngagementRecord = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    ...e,
  };
  records.push(rec);
  write(records);
  return rec;
}
