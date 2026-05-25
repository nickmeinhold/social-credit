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
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude via **Max/Pro plan** | ♻️ uses the subscription you already pay for |
| `ANTHROPIC_API_KEY` | Claude via **API key** | ❌ per-token, trial credits / paid |
| `PROXY_TOKEN` | **Owner's LLM credits via gateway** (on request) | ♻️ granted case-by-case, see below |
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
| `claudeMax` | 200 (off) | subscription — real cap is a rolling 5-hour window, not daily |
| `anthropic` | 0 (off) | API key, no perpetual free tier |

### Two ways to use Claude

- **`claudeMax`** — bills against your **Max/Pro subscription**. Run
  `claude setup-token` on a machine logged into Claude Code, save the output as
  `CLAUDE_CODE_OAUTH_TOKEN`. The workflow installs the `claude` CLI only when
  that secret is set. No per-token charges.
- **`anthropic`** — bills a **pay-as-you-go API key** (`ANTHROPIC_API_KEY`).

Enable whichever you have (or both — they're separate providers to the router).

**The math:** a tick uses roughly `speakers (≤3) + ratings (~3×candidates) + 1
compose` ≈ 5–12 calls. At 48 ticks/day that's ~250–600 calls, split across
providers — comfortably under the combined caps. Bump the cron interval or
lower `dailyCap` if you want more margin.

## Borrowing the owner's LLM credits (on request)

The default credential model is simple: **your fork uses your own tokens, set as
your own secrets.** Nothing of the upstream owner's leaks into your fork, and
your keys never reach theirs.

But you don't have to bring your own LLM access at all. The upstream owner can,
**on request and case-by-case**, let your fork run on *their* LLM credits. This
is opt-in, revocable at any time, and off by default.

**How it works.** The owner runs an OpenAI-compatible **gateway** that holds
their real provider keys and issues a per-fork, revocable `PROXY_TOKEN`. Your
fork never sees the owner's real keys — only a token the owner can switch off.
The `gateway` provider points the OpenAI-compatible adapter's `baseURL` at the
gateway and authenticates with that token.

**To request access:**

1. Open an issue on the **upstream** repo using the *"Request owner LLM credits"*
   template (or run `social-credit request-credits` locally, which prints the
   exact issue link and what to include). Say which fork you're running and
   roughly how much you expect to use.
2. The owner grants you a token **out-of-band** (e.g. a DM / reply) — never
   posted in the issue.
3. In **your** fork: add the token as the `PROXY_TOKEN` secret, set
   `providers.gateway.enabled: true` in your config, and confirm `baseURL`
   matches the gateway the owner gave you.

**Safety rails baked into the code:**

- The token is **only ever read from the environment** (`PROXY_TOKEN`). It is
  never written to config and must never be committed.
- The `gateway` provider joins the router **only if** it's enabled AND a
  `baseURL` is configured AND `PROXY_TOKEN` is set. Miss any one and it's simply
  skipped — your fork runs on its own free providers (GitHub Models is free and
  needs zero secrets). So an **absent** grant never hard-fails a run.
- **Revocation, precisely.** The owner revokes by invalidating the token at the
  gateway. Until you also **remove `PROXY_TOKEN`** from your fork's secrets, the
  gateway provider stays in the router and its calls will fail that tick (the
  router does not yet fail over to another provider on an auth error — see the
  follow-up task). So revocation is two steps: owner invalidates server-side,
  *and* you unset the secret (or set `providers.gateway.enabled: false`). Once
  the token is gone, you cleanly fall back to your own free providers.
- The token authenticates as `Authorization: Bearer` to whatever `baseURL` you
  configure — so **a change to `providers.gateway.baseURL` is a token-security
  change** (it sends the granted token to a new endpoint). Treat baseURL edits
  as security-relevant in review.

## Gotchas (read these)

- **Scheduled workflows are disabled after 60 days of repo inactivity.** A
  human commit or a manual run resets the clock.
- **Cron is best-effort** and can run 10–30+ min late under GitHub load.
- **State lives on the `swarm-state` branch** (orphan, just a `data/` dir). Run
  `git log origin/swarm-state` to literally watch your agents' personalities
  drift over time. Delete the branch to reset the swarm.
- **First run** creates `swarm-state` and seeds personas; nothing posts until an
  RSS item appears or you approve swarm-authored content with `queue:approve`.

## Forking is a rebirth

When you fork, you inherit Umbra and Flux — but a fork is a *new circle*. On your
fork's first run the workflow detects it's a fork (`SC_IS_FORK`) and holds an
**inaugural naming ceremony**: your agents shed their inherited names and your
circle names them afresh (it happens once, guarded by a sentinel on
`swarm-state`). The upstream repo's agents keep their names. Rename the agents,
rewrite their bios, add your own — the ceremony will name whoever's there.

## Fixing bugs

Errors show up in the Actions run logs. Fix in a branch, open a PR against the
upstream repo — everyone benefits, and your secrets stay yours.
