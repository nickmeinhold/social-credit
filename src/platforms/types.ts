/**
 * The contract every social platform must satisfy.
 *
 * Keeping this interface deliberately small is what lets us treat Bluesky,
 * Mastodon and LinkedIn as interchangeable sinks: the daemon only knows how to
 * `connect()` and `publish()`, never the per-platform quirks. New platforms are
 * added by implementing this interface and registering in `platforms/index.ts`.
 */

/** A piece of content to publish, platform-agnostic. */
export interface Post {
  /** The body text. Adapters truncate/format to their own limits. */
  text: string;
  /** Canonical URL of the underlying content (blog post, etc.), if any. */
  link?: string;
  /** Title of the underlying content, used for link cards / framing. */
  title?: string;
  /** Hashtag-style tags, without the leading '#'. */
  tags?: string[];
}

/** The receipt for a successful publish. */
export interface PublishResult {
  platform: string;
  /** Permalink to the created post, when the API returns one. */
  url?: string;
  /** Platform-native id (URI, status id, URN...). */
  id?: string;
}

/**
 * A reference to an EXISTING post we want to engage with (like/repost), as
 * opposed to one we're authoring. Different platforms identify a post
 * differently, so we carry both a web URL and the native id where we have it.
 */
export interface PostRef {
  /** The post's public web URL (e.g. a bsky.app or Mastodon permalink). */
  url?: string;
  /** Platform-native id when known (AT-proto at:// URI, Mastodon status id). */
  id?: string;
}

/** The receipt for a successful engagement (like/repost). */
export interface EngageResult {
  platform: string;
  /** Native id of the created like/repost record, when the API returns one. */
  id?: string;
}

export interface PlatformAdapter {
  /** Stable key, e.g. "bluesky". Must match the config key. */
  readonly name: string;

  /** True once credentials are present in config. Cheap, no network. */
  isConfigured(): boolean;

  /** Authenticate. Must be idempotent — the daemon may call it repeatedly. */
  connect(): Promise<void>;

  /** Publish a post AS THE USER. Throws on failure. */
  publish(post: Post): Promise<PublishResult>;

  /**
   * Like/favourite an existing post AS THE USER. Optional: not every platform's
   * API exposes it (LinkedIn doesn't, without extra product approval), so the
   * daemon checks for the method before calling. Throws on failure.
   *
   * Outward side effect on a third party's post — gated by the engagement
   * policy (rate limit + non-reciprocity + jitter) before it's ever called.
   */
  like?(ref: PostRef): Promise<EngageResult>;

  /** Repost/reblog an existing post AS THE USER. Optional; same gating as `like`. */
  repost?(ref: PostRef): Promise<EngageResult>;
}
