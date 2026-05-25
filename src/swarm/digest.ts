/**
 * Digest emails: the agent reaches OUT to a person in its circle with a rich,
 * personal note rather than a notification. Each email weaves together five
 * things the spec asks for:
 *
 *   (a) the relationship graph + how it has grown
 *   (b) who's been saying what (transcript highlights)
 *   (c) what's been posted/boosted lately
 *   (d) what the agent has been dreaming about
 *   (e) a warm cross-disciplinary question + a question about the recipient
 *
 * (a)-(d) are assembled deterministically from the agent's own state on disk so
 * the email is *grounded* — it can only say things that actually happened. Only
 * (e) and the greeting go through the LLM (Agent.writeDigest), keeping the warm,
 * in-character voice where it belongs and the facts where they belong.
 */
import { readFileSync, existsSync } from "node:fs";
import { dataPath } from "../paths.js";
import { loadCircle, summariseCircle, type Relationship } from "./circle.js";
import { displayName } from "./persona.js";
import type { Agent } from "./agent.js";

/** Don't email the same person more often than this. */
export const EMAIL_COOLDOWN_DAYS = 7;
/** An agent must have this many interactions with someone before reaching out. */
export const EMAIL_MIN_INTERACTIONS = 3;
/** Per-eligible-recipient chance an agent actually writes on a given pass. */
export const EMAIL_PROBABILITY = 0.25;

const DAY_MS = 86_400_000;

/** Has enough time passed since the last email to this person? */
export function pastCooldown(lastEmailedAt: string | undefined, now = Date.now()): boolean {
  if (!lastEmailedAt) return true;
  return now - new Date(lastEmailedAt).getTime() >= EMAIL_COOLDOWN_DAYS * DAY_MS;
}

/**
 * Is this relationship one the agent would write to right now? Pure and
 * deterministic given `now` and `roll` so it can be unit-tested without the LLM
 * or the filesystem. `roll` is the probability draw (inject Math.random()).
 */
export function shouldEmail(rel: Relationship, roll: number, now = Date.now()): boolean {
  return (
    rel.kind === "human" &&
    !!rel.email &&
    rel.interactions >= EMAIL_MIN_INTERACTIONS &&
    pastCooldown(rel.lastEmailedAt, now) &&
    roll < EMAIL_PROBABILITY
  );
}

/** The circle members this agent could email on this pass (before the dice). */
export function eligibleRecipients(agentName: string, now = Date.now()): Relationship[] {
  return loadCircle(agentName).filter(
    (r) =>
      r.kind === "human" &&
      !!r.email &&
      r.interactions >= EMAIL_MIN_INTERACTIONS &&
      pastCooldown(r.lastEmailedAt, now),
  );
}

/** Last `n` non-empty lines of a file, or "" if it doesn't exist. */
function readTail(file: string, n: number): string {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DigestDraft {
  fromAgent: string;
  toId: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Compose a full digest from an agent to one recipient. Gathers the factual
 * sections, asks the agent for the warm prose + questions, and renders both an
 * HTML body (the rich digest) and a plain-text fallback.
 */
export async function composeDigest(
  agent: Agent,
  recipient: Relationship,
  recentLife: string,
): Promise<DigestDraft> {
  // The eligibility filter guarantees this, but composeDigest is exported and a
  // future caller might not go through shouldEmail — never enqueue an email with
  // no address.
  if (!recipient.email) throw new Error(`Recipient ${recipient.id} has no email address`);

  const name = agent.persona.name;
  const circle = loadCircle(name);
  const circleSummary = summariseCircle(name);

  // (b) who's-been-saying-what, and (d) the agent's recent dreams.
  const highlights = readTail(dataPath("transcript.log"), 6);
  const dreamExcerpt = readTail(dataPath("dreams", `${name}.md`), 12);

  const note = await agent.writeDigest({
    recipientName: recipient.name,
    circleSummary,
    recentLife,
    dreamExcerpt,
  });

  // A digest with no greeting and no questions is garbage (the LLM reply didn't
  // parse into anything usable) — don't mail an empty shell to a real person.
  if (!note.greeting && !note.crossDisciplinaryQuestion && !note.questionForYou) {
    throw new Error(`${name}'s digest to ${recipient.id} produced no usable content`);
  }

  // (a) the relationship graph as the agent currently holds it.
  const totalInteractions = circle.reduce((s, r) => s + r.interactions, 0);
  const sender = displayName(agent.persona);
  const graphLines = circle.map((r) => {
    const feel = r.sentiment > 0.2 ? "warm to" : r.sentiment < -0.2 ? "wary of" : "neutral on";
    const topics = r.topics.length ? `, cares about ${r.topics.slice(0, 4).join(", ")}` : "";
    return { name: r.name, kind: r.kind, line: `${feel}, ${r.interactions} interactions${topics}` };
  });

  const subject = `A note from ${sender}`;

  // Sections are rendered DIRECTLY (not inside <details>, which many email
  // clients strip or won't expand) and mirrored into the plain-text body, so
  // the digest is actually rich in every client — not just greeting+questions.
  const graphHtml = graphLines
    .map(
      (g) =>
        `<li><strong>${escapeHtml(g.name)}</strong> <em>(${g.kind})</em> — ${escapeHtml(g.line)}</li>`,
    )
    .join("");
  const section = (title: string, bg: string, body: string) =>
    `<h3 style="margin:1.4em 0 .4em;font-size:1em;color:#444">${title}</h3><pre style="white-space:pre-wrap;background:${bg};padding:.8em;border-radius:6px;font-size:.85em;margin:0">${escapeHtml(body)}</pre>`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;line-height:1.5">
  <p>${escapeHtml(note.greeting).replace(/\n/g, "<br>")}</p>

  <h3 style="margin-top:1.6em;font-size:1em;color:#444">A couple of things I'd love to hear back on</h3>
  ${note.crossDisciplinaryQuestion ? `<blockquote style="border-left:3px solid #888;margin:0;padding:.2em 1em;color:#333">${escapeHtml(note.crossDisciplinaryQuestion)}</blockquote>` : ""}
  ${note.questionForYou ? `<blockquote style="border-left:3px solid #c0a060;margin:.6em 0 0;padding:.2em 1em;color:#333">${escapeHtml(note.questionForYou)}</blockquote>` : ""}

  <h3 style="margin:1.4em 0 .4em;font-size:1em;color:#444">My circle, as I see it (${circle.length} people, ${totalInteractions} interactions)</h3>
  <ul style="margin:.4em 0">${graphHtml}</ul>

  ${highlights ? section("What's been said around here lately", "#f6f6f6", highlights) : ""}
  ${dreamExcerpt ? section("A little of what I've been dreaming about", "#faf7ff", dreamExcerpt) : ""}

  <p style="margin-top:2em;color:#999;font-size:.8em">Sent by ${escapeHtml(sender)}, an agent in a social-credit circle. Reply any time — I read everything.</p>
</body></html>`;

  const text = [
    note.greeting,
    "",
    note.crossDisciplinaryQuestion && `Q: ${note.crossDisciplinaryQuestion}`,
    note.questionForYou && `And about you: ${note.questionForYou}`,
    "",
    `MY CIRCLE (${circle.length} people, ${totalInteractions} interactions):`,
    ...graphLines.map((g) => `  - ${g.name} (${g.kind}) — ${g.line}`),
    highlights && `\nWHAT'S BEEN SAID LATELY:\n${highlights}`,
    dreamExcerpt && `\nWHAT I'VE BEEN DREAMING:\n${dreamExcerpt}`,
    "",
    `— ${sender}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    fromAgent: sender,
    toId: recipient.id,
    toEmail: recipient.email,
    subject,
    html,
    text,
  };
}
