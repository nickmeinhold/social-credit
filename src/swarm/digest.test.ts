/**
 * Tests for the digest eligibility logic — the rules that decide WHEN an agent
 * reaches out. Kept pure (no SMTP, no LLM, no filesystem) by testing the
 * predicates directly with constructed relationships and an injected clock/dice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pastCooldown,
  shouldEmail,
  EMAIL_COOLDOWN_DAYS,
  EMAIL_MIN_INTERACTIONS,
  EMAIL_PROBABILITY,
} from "./digest.js";
import type { Relationship } from "./circle.js";

const NOW = Date.parse("2026-05-25T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function human(over: Partial<Relationship> = {}): Relationship {
  return {
    id: "robin",
    name: "Robin",
    kind: "human",
    email: "robin@example.com",
    notes: [],
    sentiment: 0,
    topics: [],
    interactions: EMAIL_MIN_INTERACTIONS,
    ...over,
  };
}

test("pastCooldown: never-emailed is always eligible", () => {
  assert.equal(pastCooldown(undefined, NOW), true);
});

test("pastCooldown: respects the cooldown window", () => {
  assert.equal(pastCooldown(daysAgo(EMAIL_COOLDOWN_DAYS - 1), NOW), false);
  assert.equal(pastCooldown(daysAgo(EMAIL_COOLDOWN_DAYS + 1), NOW), true);
});

test("shouldEmail: a warm, established human passes when the dice favour it", () => {
  assert.equal(shouldEmail(human(), 0, NOW), true);
});

test("shouldEmail: the probability gate blocks an unlucky roll", () => {
  assert.equal(shouldEmail(human(), EMAIL_PROBABILITY + 0.01, NOW), false);
});

test("shouldEmail: never email agents, only humans", () => {
  assert.equal(shouldEmail(human({ kind: "agent" }), 0, NOW), false);
});

test("shouldEmail: a human with no email address is skipped", () => {
  assert.equal(shouldEmail(human({ email: undefined }), 0, NOW), false);
});

test("shouldEmail: too few interactions means not-yet-acquainted", () => {
  assert.equal(shouldEmail(human({ interactions: EMAIL_MIN_INTERACTIONS - 1 }), 0, NOW), false);
});

test("shouldEmail: still in cooldown blocks even a favourable roll", () => {
  assert.equal(shouldEmail(human({ lastEmailedAt: daysAgo(1) }), 0, NOW), false);
});
