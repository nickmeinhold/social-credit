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

  // (a) the relationship graph as the agent currently holds it.
  const totalInteractions = circle.reduce((s, r) => s + r.interactions, 0);
  const graphRows = circle
    .map((r) => {
      const feel = r.sentiment > 0.2 ? "warm to" : r.sentiment < -0.2 ? "wary of" : "neutral on";
      return `<li><strong>${escapeHtml(r.name)}</strong> <em>(${r.kind})</em> — ${feel}, ${
        r.interactions
      } interactions${r.topics.length ? `, cares about ${escapeHtml(r.topics.slice(0, 4).join(", "))}` : ""}</li>`;
    })
    .join("");

  const subject = `A note from ${displayName(agent.persona)}`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;line-height:1.5">
  <p>${escapeHtml(note.greeting).replace(/\n/g, "<br>")}</p>

  <h3 style="margin-top:1.6em">A couple of things I'd love to hear back on</h3>
  ${note.crossDisciplinaryQuestion ? `<blockquote style="border-left:3px solid #888;margin:0;padding:.2em 1em;color:#333">${escapeHtml(note.crossDisciplinaryQuestion)}</blockquote>` : ""}
  ${note.questionForYou ? `<blockquote style="border-left:3px solid #c0a060;margin:.6em 0 0;padding:.2em 1em;color:#333">${escapeHtml(note.questionForYou)}</blockquote>` : ""}

  <details style="margin-top:1.6em"><summary style="cursor:pointer;color:#555">My circle, as I see it (${circle.length} people, ${totalInteractions} interactions so far)</summary>
    <ul style="margin:.6em 0">${graphRows}</ul>
  </details>

  ${highlights ? `<details style="margin-top:.6em"><summary style="cursor:pointer;color:#555">What's been said around here lately</summary><pre style="white-space:pre-wrap;background:#f6f6f6;padding:.8em;border-radius:6px;font-size:.85em">${escapeHtml(highlights)}</pre></details>` : ""}

  ${dreamExcerpt ? `<details style="margin-top:.6em"><summary style="cursor:pointer;color:#555">A little of what I've been dreaming about</summary><pre style="white-space:pre-wrap;background:#faf7ff;padding:.8em;border-radius:6px;font-size:.85em">${escapeHtml(dreamExcerpt)}</pre></details>` : ""}

  <p style="margin-top:2em;color:#999;font-size:.8em">Sent by ${escapeHtml(displayName(agent.persona))}, an agent in a social-credit circle. Reply any time — I read everything.</p>
</body></html>`;

  const text = [
    note.greeting,
    "",
    note.crossDisciplinaryQuestion && `Q: ${note.crossDisciplinaryQuestion}`,
    note.questionForYou && `And about you: ${note.questionForYou}`,
    "",
    `— ${displayName(agent.persona)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    fromAgent: displayName(agent.persona),
    toId: recipient.id,
    toEmail: recipient.email!,
    subject,
    html,
    text,
  };
}
