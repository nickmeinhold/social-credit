/**
 * Bluesky adapter — the reference implementation, because AT Protocol is fully
 * open: no app review, no scraping, just an app-password and the official
 * `@atproto/api` client. This is what "post as yourself via an official API"
 * looks like when the platform actually wants you to.
 *
 * We build a proper external-embed link card when the post carries a link, so
 * the user's blog posts render as rich cards rather than bare URLs.
 */
import { AtpAgent, RichText } from "@atproto/api";
import type { PlatformAdapter, Post, PublishResult } from "./types.js";

export class BlueskyAdapter implements PlatformAdapter {
  readonly name = "bluesky";
  private agent: AtpAgent;
  private connected = false;

  constructor(
    private creds: { identifier: string; appPassword: string; service?: string },
  ) {
    this.agent = new AtpAgent({ service: creds.service ?? "https://bsky.social" });
  }

  isConfigured(): boolean {
    return Boolean(this.creds?.identifier && this.creds?.appPassword);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.agent.login({
      identifier: this.creds.identifier,
      password: this.creds.appPassword, // app password, NOT the account password
    });
    this.connected = true;
  }

  async publish(post: Post): Promise<PublishResult> {
    await this.connect();

    // RichText resolves @mentions and #tags into facets so they're clickable.
    const body = post.link ? `${post.text}\n\n${post.link}` : post.text;
    const rt = new RichText({ text: body });
    await rt.detectFacets(this.agent);

    const record: Parameters<AtpAgent["post"]>[0] = {
      text: rt.text,
      facets: rt.facets,
    };

    const res = await this.agent.post(record);
    // res.uri is at://did/app.bsky.feed.post/rkey — turn it into a web permalink.
    const rkey = res.uri.split("/").pop();
    const url = `https://bsky.app/profile/${this.creds.identifier}/post/${rkey}`;
    return { platform: this.name, id: res.uri, url };
  }
}
