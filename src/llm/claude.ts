/**
 * Thin wrapper over the Anthropic SDK for the swarm.
 *
 * Two design choices worth flagging:
 *  - **Prompt caching on the persona block.** Each agent's personality is a
 *    large, stable system prompt reused across every turn. Marking it with
 *    `cache_control` means we pay full token price once per ~5-min window and a
 *    fraction thereafter — material when dozens of agents each speak repeatedly.
 *  - **The client is model-agnostic.** Callers pass the model so the swarm can
 *    run cheap (Haiku) while one-off "original content" generation can opt into
 *    a stronger model.
 */
import Anthropic from "@anthropic-ai/sdk";

export class Claude {
  private client: Anthropic;
  constructor(apiKey: string, private defaultModel: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Single-turn completion. `system` is cached; `messages` is the live turn.
   * Returns the concatenated text content.
   */
  async complete(opts: {
    system: string;
    messages: Anthropic.MessageParam[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    const res = await this.client.messages.create({
      model: opts.model ?? this.defaultModel,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 1,
      // The persona is the cacheable prefix — stable across the agent's life.
      system: [
        {
          type: "text",
          text: opts.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: opts.messages,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
