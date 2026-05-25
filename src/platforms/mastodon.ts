/**
 * Mastodon adapter. Mastodon's REST API is token-based and first-class — you
 * create an application in Preferences -> Development and get an access token.
 * Posting is a single authenticated POST to /api/v1/statuses. No SDK needed.
 */
import type {
  PlatformAdapter,
  Post,
  PublishResult,
  PostRef,
  EngageResult,
} from "./types.js";

export class MastodonAdapter implements PlatformAdapter {
  readonly name = "mastodon";
  constructor(private creds: { instance: string; accessToken: string }) {}

  isConfigured(): boolean {
    return Boolean(this.creds?.instance && this.creds?.accessToken);
  }

  async connect(): Promise<void> {
    // Token auth is stateless; nothing to do until publish. Validate lazily.
  }

  async publish(post: Post): Promise<PublishResult> {
    const tags = (post.tags ?? []).map((t) => `#${t}`).join(" ");
    const status = [post.text, post.link, tags].filter(Boolean).join("\n\n");

    const base = this.creds.instance.replace(/\/$/, "");
    const res = await fetch(`${base}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.creds.accessToken}`,
        "Content-Type": "application/json",
        // Idempotency key prevents double-posts on retry within the window.
        "Idempotency-Key": `${post.link ?? post.text}`.slice(0, 64),
      },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`Mastodon publish failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { id: string; url: string };
    return { platform: this.name, id: json.id, url: json.url };
  }

  /** Favourite ("like") an existing status. Needs the status id on THIS instance. */
  async like(ref: PostRef): Promise<EngageResult> {
    const id = await this.statusId(ref);
    await this.act(`statuses/${id}/favourite`);
    return { platform: this.name, id };
  }

  /** Reblog ("repost") an existing status. */
  async repost(ref: PostRef): Promise<EngageResult> {
    const id = await this.statusId(ref);
    await this.act(`statuses/${id}/reblog`);
    return { platform: this.name, id };
  }

  /** POST to a status action endpoint, throwing on a non-OK response. */
  private async act(path: string): Promise<void> {
    const base = this.creds.instance.replace(/\/$/, "");
    const res = await fetch(`${base}/api/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
    });
    if (!res.ok) throw new Error(`Mastodon ${path} failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Resolve a PostRef to a status id ON THIS INSTANCE. A native `ref.id` is
   * trusted as-is; a remote URL is resolved via the instance's search endpoint,
   * which returns the local id for a federated status (required — you can only
   * favourite/reblog by the id your own instance assigns).
   */
  private async statusId(ref: PostRef): Promise<string> {
    if (ref.id) return ref.id;
    if (!ref.url) throw new Error("Mastodon: engagement needs a status id or url");
    const base = this.creds.instance.replace(/\/$/, "");
    const res = await fetch(
      `${base}/api/v2/search?type=statuses&resolve=true&q=${encodeURIComponent(ref.url)}`,
      { headers: { Authorization: `Bearer ${this.creds.accessToken}` } },
    );
    if (!res.ok) throw new Error(`Mastodon search failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { statuses: { id: string }[] };
    const found = json.statuses?.[0]?.id;
    if (!found) throw new Error(`Mastodon: couldn't resolve status for ${ref.url}`);
    return found;
  }
}
