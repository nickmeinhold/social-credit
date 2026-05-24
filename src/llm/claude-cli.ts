/**
 * Claude via the `claude` CLI (Claude Code) — bills against a **Max/Pro
 * subscription** instead of API credits.
 *
 * How the auth works: on a machine logged into Claude Code with a Max/Pro plan,
 * run `claude setup-token` once to mint a long-lived OAuth token, store it as
 * the secret CLAUDE_CODE_OAUTH_TOKEN. The CLI picks it up from the environment
 * automatically — we never pass it on the command line. In CI we `npm i -g
 * @anthropic-ai/claude-code` so the binary exists.
 *
 * This is the same pattern as the-dreaming-repo: `claude -p --model … \
 * --system-prompt … "<prompt>"` and read stdout.
 *
 * Caveat vs the API key path: a subscription's limit is a *rolling 5-hour
 * window*, not a per-day request count, so the router's `dailyCap` here is a
 * courtesy throttle rather than a hard free-tier ceiling.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LLM, CompleteOpts } from "./types.js";

const run = promisify(execFile);

export class ClaudeCliProvider implements LLM {
  readonly id = "claude-max";
  /** `model` is a Claude Code alias ("sonnet"/"opus"/"haiku") or a full id. */
  constructor(private model: string, private bin = "claude") {}

  async complete(o: CompleteOpts): Promise<string> {
    // The swarm only ever sends a single user turn; fold any history into one
    // prompt for the CLI's positional argument.
    const prompt = o.messages.map((m) => m.content).join("\n\n");

    const args = [
      "-p", // print mode: non-interactive, prints the reply and exits
      "--model",
      this.model,
      // Replace Claude Code's default system prompt with the agent's persona —
      // we want the persona's voice, not "you are Claude Code".
      "--system-prompt",
      o.system,
      prompt,
    ];

    try {
      const { stdout } = await run(this.bin, args, {
        // CLAUDE_CODE_OAUTH_TOKEN is inherited from process.env (the secret).
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`claude CLI failed: ${e.stderr?.trim() || e.message}`);
    }
  }
}
