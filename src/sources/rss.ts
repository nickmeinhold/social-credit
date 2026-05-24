/**
 * RSS/Atom source — how the daemon discovers the user's OWN new content.
 *
 * We track which entries we've already seen in `data/seen.json` so polling the
 * same feed repeatedly only surfaces genuinely new posts. The queue also dedupes
 * by link, so this is belt-and-braces.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { DATA_DIR, dataPath } from "../paths.js";
import Parser from "rss-parser";

export interface FeedItem {
  title: string;
  link: string;
  contentSnippet: string;
}

const SEEN_FILE = () => dataPath("seen.json");
const parser = new Parser();

function loadSeen(): Set<string> {
  if (!existsSync(SEEN_FILE())) return new Set();
  return new Set(JSON.parse(readFileSync(SEEN_FILE(), "utf8")) as string[]);
}
function saveSeen(seen: Set<string>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SEEN_FILE(), JSON.stringify([...seen], null, 2));
}

/** Return only entries not seen before across all feeds, and mark them seen. */
export async function pollNewItems(feedUrls: string[]): Promise<FeedItem[]> {
  const seen = loadSeen();
  const fresh: FeedItem[] = [];

  for (const url of feedUrls) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items) {
        const link = item.link ?? item.guid;
        if (!link || seen.has(link)) continue;
        seen.add(link);
        fresh.push({
          title: item.title ?? "(untitled)",
          link,
          contentSnippet: (item.contentSnippet ?? item.content ?? "").slice(0, 500),
        });
      }
    } catch (err) {
      console.error(`[rss] failed to poll ${url}:`, (err as Error).message);
    }
  }

  saveSeen(seen);
  return fresh;
}
