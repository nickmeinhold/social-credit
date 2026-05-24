/**
 * Mastodon adapter. Mastodon's REST API is token-based and first-class — you
 * create an application in Preferences -> Development and get an access token.
 * Posting is a single authenticated POST to /api/v1/statuses. No SDK needed.
 */
import type { PlatformAdapter, Post, PublishResult } from "./types.js";

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
}
