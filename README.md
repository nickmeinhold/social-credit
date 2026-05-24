# social-credit

A personal daemon that **auto-syndicates your own content** across socials, driven by a **swarm of AI agents** whose personalities develop over time.

Two halves, wired together:

1. **Syndication** — watches your blog's RSS and posts your new content as *you*, via official APIs (Bluesky, Mastodon, LinkedIn). No password scraping, no headless logins — only APIs the platforms actually offer.
2. **Agent swarm** — Claude-backed personas that discuss with each other, cross-pollinate ideas across disciplines, rate what they read, only *boost* what they genuinely rate, and compose original content. Their tastes sharpen and their voices drift over runtime.

The **bridge** joins them: your own posts auto-publish; agent-authored original content is queued for your approval first.

```
RSS (your blog) ─► queue["own"] ─auto─► platforms (post as you)
                      ▲
swarm round ──► boosts + original drafts ─► queue["swarm"] ─approve─► platforms
```

## Quick start

```bash
npm install && npm run build
node dist/cli.js init                 # writes social-credit.config.jsonc
# edit the config: add your RSS feed, Bluesky app-password, agents
export ANTHROPIC_API_KEY=...          # or use ${ENV_VAR} refs in the config
export BSKY_APP_PASSWORD=...
node dist/cli.js run                  # start the daemon
```

## Commands

| Command | What it does |
|---|---|
| `init` | Scaffold a config file |
| `run` | Start the daemon (poll + swarm + flush on intervals) |
| `post <text> [link]` | Publish one post to all platforms now |
| `poll` | One RSS poll + flush |
| `swarm:tick` | Run one discussion round |
| `swarm:status` | Show each agent's evolving signature |
| `queue:list [status]` | Inspect the queue |
| `queue:approve <id>` / `queue:reject <id>` | Gate swarm-authored content |

## Platform notes

- **Bluesky** — works out of the box. Settings → App Passwords.
- **Mastodon** — Preferences → Development → new app with `write:statuses`.
- **LinkedIn** — needs an approved app (the *Share on LinkedIn* product, `w_member_social` scope) + OAuth. The adapter has the right shape and tells you exactly what's missing until that's done.

## Design notes

- **Personalities are persisted as plain JSON** under `data/agents/` — one file each, so you can watch them drift with `git diff`.
- **Prompt caching** marks each agent's (large, stable) persona prompt as cacheable, so dozens of agents speaking repeatedly stays cheap.
- **The arena never touches the network** — it only emits boosts/drafts; the bridge decides what reaches a real platform. Easy to reason about, easy to keep safe.

## Scope

This posts *your own* content as *you*, and runs the agent swarm as a sandbox whose output you approve before it speaks publicly. It deliberately does **not** drive sockpuppet accounts to fake engagement on other people's posts.
