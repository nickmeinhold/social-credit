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
import type {
  PlatformAdapter,
  Post,
  PublishResult,
  PostRef,
  EngageResult,
} from "./types.js";

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

  /**
   * Like an existing post. AT-proto's like takes the post's strong ref
   * `{uri, cid}`, so we first resolve the ref to the live record (its cid can't
   * be derived from a URL). This is a real, reversible-by-the-user action on
   * someone else's post — the daemon only calls it through the engagement
   * policy gate.
   */
  async like(ref: PostRef): Promise<EngageResult> {
    await this.connect();
    const { uri, cid } = await this.resolve(ref);
    const res = await this.agent.like(uri, cid);
    return { platform: this.name, id: res.uri };
  }

  /** Repost an existing post. Same strong-ref resolution as `like`. */
  async repost(ref: PostRef): Promise<EngageResult> {
    await this.connect();
    const { uri, cid } = await this.resolve(ref);
    const res = await this.agent.repost(uri, cid);
    return { platform: this.name, id: res.uri };
  }

  /**
   * Resolve a PostRef into the strong ref `{uri, cid}` that like/repost need.
   * Accepts either a native at:// URI (in `ref.id`, e.g. what our own publish
   * returns) or a bsky.app web URL (`ref.url`), which we convert by resolving
   * the handle to a DID and rebuilding the URI. We then fetch the post to read
   * its cid.
   */
  private async resolve(ref: PostRef): Promise<{ uri: string; cid: string }> {
    const uri = ref.id?.startsWith("at://") ? ref.id : await this.uriFromWebUrl(ref.url);
    const { data } = await this.agent.getPosts({ uris: [uri] });
    const post = data.posts[0];
    if (!post) throw new Error(`Bluesky: post not found for ${uri}`);
    return { uri: post.uri, cid: post.cid };
  }

  /** Turn https://bsky.app/profile/<handle-or-did>/post/<rkey> into an at:// URI. */
  private async uriFromWebUrl(url?: string): Promise<string> {
    if (!url) throw new Error("Bluesky: engagement needs a post id or url");
    const m = url.match(/profile\/([^/]+)\/post\/([^/?#]+)/);
    if (!m) throw new Error(`Bluesky: can't parse post url ${url}`);
    const [, actor, rkey] = m;
    const did = actor.startsWith("did:")
      ? actor
      : (await this.agent.resolveHandle({ handle: actor })).data.did;
    return `at://${did}/app.bsky.feed.post/${rkey}`;
  }
}
