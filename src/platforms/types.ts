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

export interface PlatformAdapter {
  /** Stable key, e.g. "bluesky". Must match the config key. */
  readonly name: string;

  /** True once credentials are present in config. Cheap, no network. */
  isConfigured(): boolean;

  /** Authenticate. Must be idempotent — the daemon may call it repeatedly. */
  connect(): Promise<void>;

  /** Publish a post AS THE USER. Throws on failure. */
  publish(post: Post): Promise<PublishResult>;
}
