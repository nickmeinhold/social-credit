#!/usr/bin/env node
/**
 * CLI surface. `commander` gives us subcommands; the daemon does the work.
 *
 * Commands:
 *   init                 scaffold a config file
 *   run                  start the daemon (the "run as a daemon" use case)
 *   post <text> [link]   publish one post right now to all platforms
 *   poll                 one RSS poll + flush
 *   swarm:tick           run one discussion round
 *   swarm:status         show each agent's evolving signature
 *   queue:list [status]  inspect the draft/post queue
 *   queue:approve <id>   approve a pending (e.g. swarm-authored) item
 *   queue:reject <id>    reject a pending item
 */
import { Command } from "commander";
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { buildAdapters } from "./platforms/index.js";
import { loadAllPersonas } from "./swarm/store.js";
import { dominantDiscipline, displayName } from "./swarm/persona.js";
import { list, setStatus, enqueue } from "./bridge/queue.js";
import { history as engagementHistory } from "./bridge/engagement.js";

const program = new Command();
program.name("social-credit").description("Auto-syndicate your own content, powered by an evolving agent swarm.");

program
  .command("init")
  .description("Write a starter social-credit.config.jsonc")
  .action(() => {
    const target = "social-credit.config.jsonc";
    if (existsSync(target)) return console.error(`${target} already exists — not overwriting.`);
    const here = dirname(fileURLToPath(import.meta.url));
    // The example ships alongside the source; copy it next to the user.
    const example = join(here, "..", "social-credit.config.example.jsonc");
    if (existsSync(example)) copyFileSync(example, target);
    else writeFileSync(target, "{}\n");
    console.log(`Wrote ${target} — fill in your tokens (or use \${ENV_VAR} references).`);
  });

program
  .command("run")
  .description("Start the daemon")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.start();
    process.on("SIGINT", () => {
      d.stop();
      process.exit(0);
    });
  });

program
  .command("post <text> [link]")
  .description("Publish one post to all configured platforms right now")
  .action(async (text: string, link?: string) => {
    const cfg = loadConfig();
    const adapters = buildAdapters(cfg);
    for (const a of adapters) {
      try {
        const r = await a.publish({ text, link });
        console.log(`${a.name}: ${r.url ?? r.id}`);
      } catch (err) {
        console.error(`${a.name} failed: ${(err as Error).message}`);
      }
    }
  });

program
  .command("poll")
  .description("Poll RSS once and flush approved items")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.pollSources();
    await d.flushQueue();
  });

program
  .command("tick")
  .description("Run ONE full pass (poll + swarm + flush) and exit — used by the GitHub Action cron")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.tickOnce();
  });

program
  .command("swarm:tick")
  .description("Run one swarm discussion round")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.swarmTick();
  });

program
  .command("reflect")
  .description("Slow cadence: every agent dreams, then maybe a naming ceremony (reflect cron)")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.reflectOnce();
  });

program
  .command("dream")
  .description("Have every agent dream once (reflect on the circle)")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.dreamOnce();
  });

program
  .command("ceremony")
  .description("Hold a naming ceremony if an agent has matured")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.ceremonyOnce();
  });

program
  .command("welcome")
  .description("Fork welcome rite: on a fork (SC_IS_FORK=true), the new circle names its agents")
  .action(async () => {
    const d = new Daemon(loadConfig());
    await d.welcomeOnce();
  });

program
  .command("swarm:status")
  .description("Show each agent's evolving signature")
  .action(() => {
    const personas = loadAllPersonas();
    if (!personas.length) return console.log("No agents yet — run the daemon to seed them.");
    for (const p of personas) {
      const named = p.chosenName ? `${p.chosenName} (was ${p.name})` : `${p.name} (unnamed)`;
      console.log(
        `${displayName(p).padEnd(12)} ${named.padEnd(24)} [${p.rounds} rounds]  lens: ${dominantDiscipline(
          p,
        )}  memories: ${p.memories.length}`,
      );
    }
  });

program
  .command("queue:list [status]")
  .description("List queue items (optionally by status)")
  .action((status?: string) => {
    for (const i of list(status as any)) {
      console.log(`${i.id}  ${i.status.padEnd(9)} ${i.origin.padEnd(5)} ${i.post.text.slice(0, 60)}`);
    }
  });

program
  .command("queue:approve <id>")
  .description("Approve a pending item so it posts on the next flush")
  .action((id: string) => {
    setStatus(id, "approved");
    console.log(`Approved ${id}.`);
  });

program
  .command("queue:reject <id>")
  .description("Reject a pending item")
  .action((id: string) => {
    setStatus(id, "rejected");
    console.log(`Rejected ${id}.`);
  });

program.parseAsync();
