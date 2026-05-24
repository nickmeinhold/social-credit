/**
 * An Agent = a Persona + the ability to act through the LLM.
 *
 * Three capabilities map onto the three things the user asked for:
 *  - `speak()`    -> agents have discussions with each other
 *  - `rate()`     -> they only boost/repost when they REALLY like something
 *  - `compose()`  -> they generate original, cross-pollinated content
 *
 * Every action that changes the agent also mutates its persona (reinforce /
 * remember), which is how personalities develop over time rather than resetting
 * each run.
 */
import type { Claude } from "../llm/claude.js";
import {
  type Persona,
  renderSystemPrompt,
  reinforce,
  remember,
  dominantDiscipline,
} from "./persona.js";

export interface Rating {
  /** 0..1 — how much this agent genuinely rates the content. */
  score: number;
  /** One line, in character, on why. */
  reason: string;
}

export class Agent {
  constructor(public persona: Persona, private llm: Claude) {}

  private system() {
    return renderSystemPrompt(this.persona);
  }

  /** Contribute a turn to a discussion given the recent thread. */
  async speak(topic: string, thread: string[]): Promise<string> {
    const convo = thread.length
      ? `The discussion so far:\n${thread.join("\n")}`
      : `You are opening a new discussion.`;
    const text = await this.llm.complete({
      system: this.system(),
      messages: [
        {
          role: "user",
          content: `Topic: ${topic}\n\n${convo}\n\nAdd ONE contribution (2-4 sentences). Push the conversation somewhere new; don't just agree.`,
        },
      ],
      temperature: 1,
      maxTokens: 350,
    });
    this.persona.rounds += 1;
    reinforce(this.persona, dominantDiscipline(this.persona), 0.02);
    return text.trim();
  }

  /**
   * Rate a piece of external content. We force a JSON reply for a clean number,
   * and we reinforce the relevant discipline only when the agent rated it high —
   * so an agent's tastes sharpen toward what actually impressed it.
   */
  async rate(content: { title?: string; text: string }): Promise<Rating> {
    const raw = await this.llm.complete({
      system: this.system(),
      messages: [
        {
          role: "user",
          content: `Rate how much YOU genuinely rate this, by your own taste. Be hard to impress.\n\n${
            content.title ? `Title: ${content.title}\n` : ""
          }${content.text}\n\nReply ONLY as JSON: {"score": <0..1>, "reason": "<one line>", "discipline": "<which of your disciplines it most touches>"}`,
        },
      ],
      temperature: 0.4,
      maxTokens: 200,
    });
    const r = safeParseRating(raw);
    if (r.score >= 0.7 && r.discipline) reinforce(this.persona, r.discipline, 0.06);
    remember(this.persona, `Read "${content.title ?? content.text.slice(0, 40)}" — rated ${r.score.toFixed(2)}: ${r.reason}`, r.score);
    return { score: r.score, reason: r.reason };
  }

  /** Generate an original short post, cross-pollinating its top disciplines. */
  async compose(seed?: string): Promise<string> {
    const text = await this.llm.complete({
      system: this.system(),
      messages: [
        {
          role: "user",
          content: `Write an original short post (under 280 chars) in your own voice. ${
            seed ? `Spark: ${seed}. ` : ""
          }Cross-pollinate at least two of your disciplines into one surprising idea. No hashtags unless they earn their place.`,
        },
      ],
      temperature: 1.1,
      maxTokens: 200,
    });
    this.persona.rounds += 1;
    return text.trim();
  }
}

function safeParseRating(raw: string): Rating & { discipline?: string } {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : raw);
    return {
      score: Math.max(0, Math.min(1, Number(o.score) || 0)),
      reason: String(o.reason ?? "").slice(0, 200),
      discipline: o.discipline ? String(o.discipline) : undefined,
    };
  } catch {
    return { score: 0, reason: "unparseable rating" };
  }
}
