/**
 * LinkedIn adapter — official UGC Posts API (/rest/posts).
 *
 * PRACTICAL GATE (not an ethics one): LinkedIn gates the `w_member_social`
 * scope behind their "Share on LinkedIn" / Marketing Developer Platform product
 * approval. You must create an app at https://developer.linkedin.com, request
 * the product, and complete OAuth to mint a member access token. Until that's
 * done this adapter has the right *shape* but `connect()` will surface the gate.
 *
 * `authorUrn` is your member URN, e.g. "urn:li:person:abc123", obtained from the
 * /userinfo (OpenID) endpoint after OAuth.
 */
import type { PlatformAdapter, Post, PublishResult } from "./types.js";

export class LinkedInAdapter implements PlatformAdapter {
  readonly name = "linkedin";
  constructor(private creds: { accessToken: string; authorUrn: string }) {}

  isConfigured(): boolean {
    return Boolean(this.creds?.accessToken && this.creds?.authorUrn);
  }

  async connect(): Promise<void> {
    if (!this.isConfigured())
      throw new Error(
        "LinkedIn not configured. Create an app at developer.linkedin.com, " +
          "request the 'Share on LinkedIn' product for the w_member_social scope, " +
          "complete OAuth, then set platforms.linkedin.{accessToken,authorUrn}.",
      );
  }

  async publish(post: Post): Promise<PublishResult> {
    await this.connect();
    const commentary = [post.text, post.link].filter(Boolean).join("\n\n");

    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.creds.accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": "202405",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: this.creds.authorUrn,
        commentary,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED" },
        lifecycleState: "PUBLISHED",
      }),
    });
    if (!res.ok) throw new Error(`LinkedIn publish failed: ${res.status} ${await res.text()}`);
    // The created post id comes back in the x-restli-id header.
    const id = res.headers.get("x-restli-id") ?? undefined;
    return { platform: this.name, id };
  }
}
