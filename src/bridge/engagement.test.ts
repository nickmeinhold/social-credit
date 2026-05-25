/**
 * Tests for the engagement POLICY predicates — the part that guards
 * irreversible outward actions (real stars/likes on other people's accounts).
 *
 * We test the PURE functions only: no I/O, history passed in. These are the
 * ring-protection invariants, so they're the part worth pinning down: cap
 * enforcement, the minimum-interval throttle, the non-reciprocity guard, and
 * the jitter bounds. Run via `npm test` (node --test over compiled dist/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withinDailyCap,
  respectsMinInterval,
  wouldBeReciprocal,
  alreadyEngaged,
  jitteredDelay,
  decide,
  dayKey,
  type EngagementRecord,
  type EngagementConfig,
} from "./engagement.js";

function rec(over: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    id: "x",
    at: "2026-05-25T12:00:00.000Z",
    kind: "star",
    surface: "github",
    actor: "alice",
    target: "alice/repo",
    ...over,
  };
}

const enabled: EngagementConfig = {
  enabled: true,
  dailyCap: 3,
  minIntervalMs: 60_000,
  jitterMs: 30_000,
};

// --- daily cap ------------------------------------------------------------

test("withinDailyCap: under cap allows, at cap blocks", () => {
  const now = new Date("2026-05-25T18:00:00Z");
  assert.equal(withinDailyCap([], 3, now), true);
  const two = [rec(), rec()];
  assert.equal(withinDailyCap(two, 3, now), true);
  const three = [rec(), rec(), rec()];
  assert.equal(withinDailyCap(three, 3, now), false);
});

test("withinDailyCap: only counts SAME UTC day", () => {
  const now = new Date("2026-05-25T18:00:00Z");
  const yesterday = [
    rec({ at: "2026-05-24T23:59:00Z" }),
    rec({ at: "2026-05-24T10:00:00Z" }),
    rec({ at: "2026-05-24T08:00:00Z" }),
  ];
  // Three yesterday, none today -> a fresh day's budget is full.
  assert.equal(withinDailyCap(yesterday, 3, now), true);
});

test("withinDailyCap: cap of 0 always blocks", () => {
  assert.equal(withinDailyCap([], 0, new Date()), false);
});

// --- min interval ---------------------------------------------------------

test("respectsMinInterval: no history is fine", () => {
  assert.equal(respectsMinInterval([], 60_000, new Date()), true);
});

test("respectsMinInterval: too soon after last blocks, enough gap allows", () => {
  const last = [rec({ at: "2026-05-25T12:00:00Z" })];
  const tooSoon = new Date("2026-05-25T12:00:30Z"); // 30s < 60s
  const enough = new Date("2026-05-25T12:01:30Z"); // 90s >= 60s
  assert.equal(respectsMinInterval(last, 60_000, tooSoon), false);
  assert.equal(respectsMinInterval(last, 60_000, enough), true);
});

test("respectsMinInterval: uses the MOST RECENT action, not insertion order", () => {
  const hist = [
    rec({ at: "2026-05-25T12:05:00Z" }), // newest, listed first
    rec({ at: "2026-05-25T08:00:00Z" }),
  ];
  const now = new Date("2026-05-25T12:05:30Z"); // 30s after newest
  assert.equal(respectsMinInterval(hist, 60_000, now), false);
});

// --- non-reciprocity ------------------------------------------------------

test("wouldBeReciprocal: first engagement of an actor is allowed (lopsided OK)", () => {
  const now = new Date("2026-05-25T12:00:00Z");
  assert.equal(wouldBeReciprocal([], "alice", 86_400_000, now), false);
});

test("wouldBeReciprocal: a SECOND engagement of the same actor in-window blocks", () => {
  const now = new Date("2026-05-25T13:00:00Z");
  const hist = [rec({ actor: "alice", at: "2026-05-25T12:00:00Z" })];
  assert.equal(wouldBeReciprocal(hist, "alice", 86_400_000, now), true);
  // A different actor is unaffected.
  assert.equal(wouldBeReciprocal(hist, "bob", 86_400_000, now), false);
});

test("wouldBeReciprocal: outside the window, same actor is allowed again", () => {
  const now = new Date("2026-05-27T12:00:00Z"); // 48h later
  const hist = [rec({ actor: "alice", at: "2026-05-25T12:00:00Z" })];
  assert.equal(wouldBeReciprocal(hist, "alice", 86_400_000, now), false);
});

// --- dedupe ---------------------------------------------------------------

test("alreadyEngaged: same kind+target is a repeat; different kind is not", () => {
  const hist = [rec({ kind: "star", target: "alice/repo" })];
  assert.equal(alreadyEngaged(hist, "star", "alice/repo"), true);
  assert.equal(alreadyEngaged(hist, "like", "alice/repo"), false);
  assert.equal(alreadyEngaged(hist, "star", "bob/repo"), false);
});

// --- jitter bounds --------------------------------------------------------

test("jitteredDelay: stays within [minInterval, minInterval+jitter]", () => {
  const cfg = { minIntervalMs: 60_000, jitterMs: 30_000 };
  // rng=0 -> floor; rng just under 1 -> max.
  assert.equal(jitteredDelay(cfg, () => 0), 60_000);
  const hi = jitteredDelay(cfg, () => 0.999999);
  assert.ok(hi >= 60_000 && hi <= 90_000, `expected within bounds, got ${hi}`);
  // Random sampling never escapes the bounds.
  for (let i = 0; i < 1000; i++) {
    const d = jitteredDelay(cfg);
    assert.ok(d >= 60_000 && d <= 90_000, `out of bounds: ${d}`);
  }
});

test("jitteredDelay: zero jitter yields exactly the floor", () => {
  assert.equal(jitteredDelay({ minIntervalMs: 5000, jitterMs: 0 }), 5000);
});

// --- composed decision ----------------------------------------------------

test("decide: disabled config short-circuits to 'disabled'", () => {
  const off: EngagementConfig = { ...enabled, enabled: false };
  assert.equal(decide(off, [], { kind: "star", actor: "a", target: "a/r" }), "disabled");
});

test("decide: dailyCap of 0 reads as disabled", () => {
  const off: EngagementConfig = { ...enabled, dailyCap: 0 };
  assert.equal(decide(off, [], { kind: "star", actor: "a", target: "a/r" }), "disabled");
});

test("decide: clean first engagement returns 'ok'", () => {
  const now = new Date("2026-05-25T12:00:00Z");
  assert.equal(decide(enabled, [], { kind: "star", actor: "a", target: "a/r" }, now), "ok");
});

test("decide: precedence — already-engaged beats cap/interval/reciprocity", () => {
  const now = new Date("2026-05-25T12:00:00Z");
  const hist = [rec({ kind: "star", target: "a/r", actor: "a", at: "2026-05-25T11:59:50Z" })];
  assert.equal(
    decide(enabled, hist, { kind: "star", actor: "a", target: "a/r" }, now),
    "already-engaged",
  );
});

test("decide: at daily cap returns 'daily-cap-reached'", () => {
  const now = new Date("2026-05-25T18:00:00Z");
  const hist = [
    rec({ target: "a/r", actor: "a", at: "2026-05-25T09:00:00Z" }),
    rec({ target: "b/r", actor: "b", at: "2026-05-25T10:00:00Z" }),
    rec({ target: "c/r", actor: "c", at: "2026-05-25T11:00:00Z" }),
  ];
  assert.equal(
    decide(enabled, hist, { kind: "star", actor: "d", target: "d/r" }, now),
    "daily-cap-reached",
  );
});

test("decide: too soon after last returns 'too-soon'", () => {
  // Cap not hit (1 < 3), but only 10s since the last action (< 60s).
  const now = new Date("2026-05-25T12:00:10Z");
  const hist = [rec({ target: "a/r", actor: "a", at: "2026-05-25T12:00:00Z" })];
  assert.equal(
    decide(enabled, hist, { kind: "star", actor: "b", target: "b/r" }, now),
    "too-soon",
  );
});

test("decide: re-engaging the same actor (new target) trips reciprocity-guard", () => {
  // Cap OK, interval OK (2h gap), but same actor within 24h.
  const now = new Date("2026-05-25T14:00:00Z");
  const hist = [rec({ kind: "star", target: "a/repo1", actor: "alice", at: "2026-05-25T12:00:00Z" })];
  assert.equal(
    decide(enabled, hist, { kind: "star", actor: "alice", target: "a/repo2" }, now),
    "reciprocity-guard",
  );
});

test("dayKey: extracts the UTC date portion", () => {
  assert.equal(dayKey("2026-05-25T23:59:59.999Z"), "2026-05-25");
});
