# Forking & running your own swarm

`social-credit` is built to be **forked**. The code is public and PR-able; your
credentials live in **your fork's secrets** and never touch the repo. The
swarm runs on **GitHub Actions cron** — no server, no daemon, free.

## 1. Fork the repo

Click **Fork**. You now have your own copy with its own Actions and its own
secrets store.

## 2. Add secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Set only the ones you want:

| Secret | For | Free? |
|---|---|---|
| _(nothing)_ | GitHub Models provider | ✅ uses the built-in `GITHUB_TOKEN` |
| `GEMINI_API_KEY` | Gemini provider | ✅ ~1,500 flash req/day |
| `ANTHROPIC_API_KEY` | Claude provider | ❌ trial credits / paid only |
| `BSKY_APP_PASSWORD` | post to Bluesky | ✅ |
| `MASTODON_TOKEN` | post to Mastodon | ✅ |
| `LINKEDIN_TOKEN` | post to LinkedIn | needs an approved app |

> Secrets do **not** copy when others fork *you*, and PRs from forks can't read
> them — so a contributor fixing a bug never sees your keys.

## 3. Configure

Edit `social-credit.config.jsonc` (copy from the `.example`): your RSS feed,
your platform handles, your agent roster, and which providers are `enabled`.
This file is committed — it has no secrets in it.

## 4. Enable Actions

Forks have Actions disabled by default — open the **Actions** tab and enable
them. The `swarm-tick` workflow then runs every 30 min. Use **Run workflow**
to trigger one immediately and watch the logs.

## Staying just below the free tiers

The budget router (`src/llm/router.ts`) counts calls per provider per UTC day
and routes each request to the enabled provider with the most remaining
headroom, capped by `dailyCap` in your config. The defaults:

| Provider | `dailyCap` | Free-tier reality |
|---|---|---|
| `github` (GPT) | 140 | GitHub Models low-tier daily request limit |
| `gemini` | 1,200 | under the ~1,500/day flash free tier |
| `anthropic` | 0 (off) | no perpetual free tier |

**The math:** a tick uses roughly `speakers (≤3) + ratings (~3×candidates) + 1
compose` ≈ 5–12 calls. At 48 ticks/day that's ~250–600 calls, split across
providers — comfortably under the combined caps. Bump the cron interval or
lower `dailyCap` if you want more margin.

## Gotchas (read these)

- **Scheduled workflows are disabled after 60 days of repo inactivity.** A
  human commit or a manual run resets the clock.
- **Cron is best-effort** and can run 10–30+ min late under GitHub load.
- **State lives on the `swarm-state` branch** (orphan, just a `data/` dir). Run
  `git log origin/swarm-state` to literally watch your agents' personalities
  drift over time. Delete the branch to reset the swarm.
- **First run** creates `swarm-state` and seeds personas; nothing posts until an
  RSS item appears or you approve swarm-authored content with `queue:approve`.

## Fixing bugs

Errors show up in the Actions run logs. Fix in a branch, open a PR against the
upstream repo — everyone benefits, and your secrets stay yours.
