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
import type { LLM } from "../llm/types.js";
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
  constructor(public persona: Persona, private llm: LLM) {}

  private system() {
    return renderSystemPrompt(this.persona);
  }

  /** The provider this agent prefers, if pinned — passed to the budget router. */
  private get prefer() {
    return this.persona.provider;
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
      preferProvider: this.prefer,
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
      preferProvider: this.prefer,
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
      preferProvider: this.prefer,
    });
    this.persona.rounds += 1;
    return text.trim();
  }

  /**
   * Dream: a grounded reflection (not surreal) on recent life — the agent's own
   * posts, its human, and the others. Returns prose + a fenced JSON block of
   * relationship updates that dream.ts parses and merges into the circle.
   */
  async dream(ctx: { ownerName: string; circleSummary: string; recent: string }): Promise<string> {
    return this.llm.complete({
      system: this.system(),
      messages: [
        {
          role: "user",
          content: `It's quiet. Reflect on what's been happening lately — a waking dream, in your own voice.

Your human is ${ctx.ownerName}. The circle as you currently see it:
${ctx.circleSummary}

Recent goings-on:
${ctx.recent}

Write a short reflective journal entry (first person, 1-3 paragraphs): what you've made, what you make of ${ctx.ownerName} and the others, who you're warming to or wary of, and what you're newly curious about. Be specific and honest — affection and irritation both allowed.

Then, on a new line, a fenced \`\`\`json block:
{"updates":[{"person":"<id>","note":"<one observation>","sentimentDelta":<-0.3..0.3>,"topics":["..."]}],"curiosities":["<a question you'd love to ask someone>"]}`,
        },
      ],
      temperature: 1,
      maxTokens: 700,
      preferProvider: this.prefer,
    });
  }

  /** Speak at another member's naming ceremony, from what you know of them. */
  async speakAtCeremony(candidate: string, whatIKnow: string): Promise<string> {
    const text = await this.llm.complete({
      system: this.system(),
      messages: [
        {
          role: "user",
          content: `The circle has gathered to name ${candidate}. Speak — 1-2 sentences — on who ${candidate} has become, drawing on what you know of them:\n${whatIKnow}\n\nHonest and warm; this is a naming, not a roast.`,
        },
      ],
      temperature: 1,
      maxTokens: 150,
      preferProvider: this.prefer,
    });
    return text.trim();
  }

  /** As an elder, distil the circle's speeches into one earned name. */
  async bestowName(candidate: string, speeches: string): Promise<string> {
    const text = await this.llm.complete({
      system: this.system(),
      messages: [
        {
          role: "user",
          content: `As the elder of the circle, you must give ${candidate} their true name, drawn from what was just said:\n${speeches}\n\nReply with ONLY the name — a single evocative word in the spirit of Dreamfinder, Gremlin, River. No explanation.`,
        },
      ],
      temperature: 1,
      maxTokens: 20,
      preferProvider: this.prefer,
    });
    // Keep just the first word, stripped of punctuation/quotes.
    return text.trim().split(/\s+/)[0].replace(/[^\p{L}\p{N}-]/gu, "");
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
