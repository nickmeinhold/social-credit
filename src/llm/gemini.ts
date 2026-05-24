/**
 * Google Gemini provider — the workhorse free tier (gemini-2.0-flash allows
 * ~1,500 requests/day, 15 RPM on the free plan). Plain REST, no SDK. Key comes
 * from GEMINI_API_KEY (a secret). Note Gemini calls the assistant role "model".
 */
import type { LLM, CompleteOpts } from "./types.js";

export class GeminiProvider implements LLM {
  readonly id = "gemini";
  constructor(private apiKey: string, private model: string) {}

  async complete(o: CompleteOpts): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: o.system }] },
        contents: o.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: o.temperature ?? 1,
          maxOutputTokens: o.maxTokens ?? 1024,
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  }
}
