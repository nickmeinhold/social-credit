/**
 * Tests for the email queue's IRREVERSIBLE state machine — the part a unit test
 * on pure predicates can't reach. Sending a real email can't be undone, so the
 * critical property is that `sent` is terminal: you cannot re-approve a sent
 * message and have it mailed to a real person twice.
 *
 * mailer does file I/O keyed off SC_DATA_DIR (read at module load in paths.ts),
 * so we point it at a fresh temp dir and dynamic-import after setting the env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SC_DATA_DIR = mkdtempSync(join(tmpdir(), "sc-mailer-"));
const { enqueueEmail, setEmailStatus, listEmails } = await import("./mailer.js");

function draft() {
  return {
    fromAgent: "Umbra",
    toId: "robin",
    toEmail: "robin@example.com",
    subject: "A note from Umbra",
    html: "<p>hi</p>",
    text: "hi",
  };
}

test("enqueue pending -> approve -> sent is the happy path", () => {
  const item = enqueueEmail(draft(), false);
  assert.equal(item.status, "pending");
  setEmailStatus(item.id, "approved");
  setEmailStatus(item.id, "sent", { sentAt: new Date().toISOString() });
  const found = listEmails("sent").find((e) => e.id === item.id);
  assert.equal(found?.status, "sent");
});

test("a sent email cannot be re-approved (no double-send to a real person)", () => {
  const item = enqueueEmail(draft(), true); // born approved
  setEmailStatus(item.id, "sent");
  assert.throws(() => setEmailStatus(item.id, "approved"), /Illegal email transition/);
});

test("a pending email cannot jump straight to sent (must be approved first)", () => {
  const item = enqueueEmail(draft(), false);
  assert.throws(() => setEmailStatus(item.id, "sent"), /Illegal email transition/);
});

test("a rejected email is terminal", () => {
  const item = enqueueEmail(draft(), false);
  setEmailStatus(item.id, "rejected");
  assert.throws(() => setEmailStatus(item.id, "approved"), /Illegal email transition/);
});

test("same-state write is allowed (recording a transient send error keeps it approved)", () => {
  const item = enqueueEmail(draft(), true);
  setEmailStatus(item.id, "approved", { error: "smtp timeout" });
  const found = listEmails("approved").find((e) => e.id === item.id);
  assert.equal(found?.error, "smtp timeout");
});
