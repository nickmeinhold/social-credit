/**
 * Anthropic / Claude provider. No perpetual free tier — ships disabled by
 * default; forkers with trial credits or a paid key flip it on in config and
 * provide ANTHROPIC_API_KEY as a secret. Persona prompt is cache-marked.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LLM, CompleteOpts } from "./types.js";

export class AnthropicProvider implements LLM {
  readonly id = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(o: CompleteOpts): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: o.maxTokens ?? 1024,
      temperature: o.temperature ?? 1,
      system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
      messages: o.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
