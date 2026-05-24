/**
 * Platform registry. Reads config and instantiates only the adapters that have
 * credentials, so the daemon's "post to everywhere" really means "everywhere
 * the user actually connected".
 */
import type { Config } from "../config.js";
import type { PlatformAdapter } from "./types.js";
import { BlueskyAdapter } from "./bluesky.js";
import { MastodonAdapter } from "./mastodon.js";
import { LinkedInAdapter } from "./linkedin.js";

export function buildAdapters(cfg: Config): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [];
  if (cfg.platforms.bluesky) adapters.push(new BlueskyAdapter(cfg.platforms.bluesky));
  if (cfg.platforms.mastodon) adapters.push(new MastodonAdapter(cfg.platforms.mastodon));
  if (cfg.platforms.linkedin) adapters.push(new LinkedInAdapter(cfg.platforms.linkedin));
  return adapters.filter((a) => a.isConfigured());
}

export type { PlatformAdapter, Post, PublishResult } from "./types.js";
