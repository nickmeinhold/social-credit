---
name: Request owner LLM credits
about: Ask the upstream owner to let your fork run on their LLM credits (on request, revocable)
title: "[credits] Request to borrow owner LLM credits"
labels: ["credits-request"]
---

<!--
Read FORKING.md → "Borrowing the owner's LLM credits (on request)" first.

This is opt-in and revocable: if granted, the owner issues you a per-fork token
out-of-band (NOT in this issue). You set it as the PROXY_TOKEN secret in YOUR
fork and point providers.gateway.baseURL at the owner's gateway.

DO NOT paste any token, secret, or key into this issue.
-->

**Your fork:** <!-- e.g. https://github.com/you/social-credit -->

**Why you'd like to borrow credits:** <!-- trying it out / no own key / etc. -->

**Rough expected usage:** <!-- e.g. default cron, ~250-600 calls/day -->

**Acknowledgements:**

- [ ] I understand the grant is **case-by-case and revocable** at any time.
- [ ] I will set the token only as the `PROXY_TOKEN` **secret** — never in config or a commit.
- [ ] I understand my fork falls back to its own free providers if the grant is absent/revoked.
