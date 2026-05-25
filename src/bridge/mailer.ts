/**
 * The email sink + its human-in-the-loop queue.
 *
 * This is the deliberate sibling of bridge/queue.ts: agents can write emails to
 * people in their circle, but an email speaks OUTWARD to a real person, so by
 * default it lands in an approval queue (`email:list` / `email:approve` /
 * `email:flush`) and a human signs off before it sends. Set
 * `bridge.autoSendEmail` to let trusted agents send directly.
 *
 * The queue is one JSON file (`data/emails.json`) you can inspect/edit by hand,
 * exactly like the post queue. Sending uses SMTP via nodemailer, with all creds
 * read from config (which itself pulls them from env secrets) — nothing here
 * touches a key directly.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DATA_DIR, dataPath } from "../paths.js";
import type { Config } from "../config.js";

export type EmailStatus = "pending" | "approved" | "sent" | "rejected";

export interface EmailItem {
  id: string;
  createdAt: string;
  /** Display name of the agent that wrote it. */
  fromAgent: string;
  /** Circle id of the recipient (so we can stamp lastEmailedAt on send). */
  toId: string;
  toEmail: string;
  subject: string;
  /** HTML body — the rich digest. `text` is the plain-text fallback. */
  html: string;
  text: string;
  status: EmailStatus;
  sentAt?: string;
  error?: string;
}

const EMAIL_FILE = () => dataPath("emails.json");

function read(): EmailItem[] {
  if (!existsSync(EMAIL_FILE())) return [];
  return JSON.parse(readFileSync(EMAIL_FILE(), "utf8")) as EmailItem[];
}
function write(items: EmailItem[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(EMAIL_FILE(), JSON.stringify(items, null, 2));
}

/** Queue an email. Born "approved" only when autoSend is on; else "pending". */
export function enqueueEmail(
  draft: Omit<EmailItem, "id" | "createdAt" | "status">,
  autoSend: boolean,
): EmailItem {
  const items = read();
  const item: EmailItem = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: autoSend ? "approved" : "pending",
    ...draft,
  };
  items.push(item);
  write(items);
  return item;
}

export function listEmails(status?: EmailStatus): EmailItem[] {
  const items = read();
  return status ? items.filter((i) => i.status === status) : items;
}

/**
 * Legal status transitions. Sending a real email is irreversible, so `sent`
 * and `rejected` are terminal — you cannot re-`approve` a `sent` message and
 * have the next flush mail it to a real person a second time. A same-state
 * write (e.g. approved->approved to record a transient send error) is allowed.
 */
const ALLOWED_TRANSITIONS: Record<EmailStatus, EmailStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["sent", "rejected"],
  sent: [],
  rejected: [],
};

export function setEmailStatus(id: string, status: EmailStatus, patch?: Partial<EmailItem>): void {
  const items = read();
  const it = items.find((i) => i.id === id);
  if (!it) throw new Error(`No email ${id}`);
  if (it.status !== status && !ALLOWED_TRANSITIONS[it.status].includes(status)) {
    throw new Error(
      `Illegal email transition ${it.status} -> ${status} for ${id} (a sent email cannot be resent)`,
    );
  }
  it.status = status;
  if (patch) Object.assign(it, patch);
  write(items);
}

/**
 * Send one queued email via SMTP. nodemailer is imported lazily so a fork that
 * never enables email doesn't pay for the dependency at startup, and so the
 * whole module loads even if nodemailer isn't installed.
 */
export async function sendEmail(item: EmailItem, cfg: Config): Promise<void> {
  if (!cfg.email) throw new Error("email is not configured (cfg.email missing)");
  const { createTransport } = await import("nodemailer");
  const transport = createTransport({
    host: cfg.email.host,
    port: cfg.email.port,
    secure: cfg.email.secure ?? cfg.email.port === 465,
    auth: { user: cfg.email.user, pass: cfg.email.pass },
  });
  await transport.sendMail({
    from: cfg.email.from,
    to: item.toEmail,
    subject: item.subject,
    text: item.text,
    html: item.html,
  });
}
