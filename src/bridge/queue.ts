/**
 * The bridge between "things that might get posted" and "things posted as you".
 *
 * This is the human-in-the-loop join, and the policy lives here on purpose:
 *  - The user's OWN content (from RSS) is trusted: auto-posted if
 *    `bridge.autoPostOwnContent` is on.
 *  - Swarm-generated ORIGINAL content is held for approval by default — it's
 *    written by an AI persona, so a human signs off before it speaks as you.
 *
 * The queue is a single JSON file so you can inspect/approve items by hand or
 * via the CLI.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Post } from "../platforms/types.js";

export type QueueStatus = "pending" | "approved" | "posted" | "rejected";

export interface QueueItem {
  id: string;
  createdAt: string;
  /** "own" = user's content; "swarm" = AI-authored original. */
  origin: "own" | "swarm";
  status: QueueStatus;
  post: Post;
  /** Filled after a successful publish. */
  results?: { platform: string; url?: string }[];
}

const QUEUE_FILE = join("data", "queue.json");

function read(): QueueItem[] {
  if (!existsSync(QUEUE_FILE)) return [];
  return JSON.parse(readFileSync(QUEUE_FILE, "utf8")) as QueueItem[];
}
function write(items: QueueItem[]) {
  mkdirSync("data", { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2));
}

/** Add an item. Own content can be born "approved"; swarm content is "pending". */
export function enqueue(origin: QueueItem["origin"], post: Post, autoApprove: boolean): QueueItem {
  const items = read();
  // Dedupe own content by link so re-polling RSS doesn't double-post.
  if (origin === "own" && post.link && items.some((i) => i.post.link === post.link)) {
    return items.find((i) => i.post.link === post.link)!;
  }
  const item: QueueItem = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    origin,
    status: autoApprove ? "approved" : "pending",
    post,
  };
  items.push(item);
  write(items);
  return item;
}

export function list(status?: QueueStatus): QueueItem[] {
  const items = read();
  return status ? items.filter((i) => i.status === status) : items;
}

export function setStatus(id: string, status: QueueStatus, results?: QueueItem["results"]): void {
  const items = read();
  const it = items.find((i) => i.id === id);
  if (!it) throw new Error(`No queue item ${id}`);
  it.status = status;
  if (results) it.results = results;
  write(items);
}
