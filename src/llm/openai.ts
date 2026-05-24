/**
 * OpenAI-compatible provider — covers two free-ish paths through ONE adapter,
 * because both speak the OpenAI Chat Completions wire format:
 *
 *  - **GitHub Models** (default): free, rate-limited inference native to GitHub
 *    Actions. baseURL https://models.inference.ai.azure.com, authed with the
 *    workflow's built-in GITHUB_TOKEN (needs `models: read` permission). This is
 *    the "codex"/GPT leg of the swarm at zero cost.
 *  - **OpenAI proper**: set baseURL to https://api.openai.com/v1 and supply a
 *    real key, for forkers who'd rather pay.
 */
import type { LLM, CompleteOpts } from "./types.js";

export class OpenAICompatProvider implements LLM {
  readonly id: string;
  constructor(
    private apiKey: string,
    private model: string,
    private baseURL = "https://models.inference.ai.azure.com",
    id = "github",
  ) {
    this.id = id;
  }

  async complete(o: CompleteOpts): Promise<string> {
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: o.temperature ?? 1,
        max_tokens: o.maxTokens ?? 1024,
        messages: [{ role: "system", content: o.system }, ...o.messages],
      }),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }
}
