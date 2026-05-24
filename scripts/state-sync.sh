#!/usr/bin/env bash
# Persist the swarm's evolving state across otherwise-stateless GitHub Actions
# runs by keeping it in a dedicated orphan branch `swarm-state` that contains
# ONLY a data/ directory. This is what lets personalities drift over weeks: each
# tick restores the branch, mutates data/, and commits it back.
#
# Usage:
#   scripts/state-sync.sh restore   # check the branch out into .swarm-state/
#   scripts/state-sync.sh save      # commit + push data/ changes
#
# The app is pointed at this checkout via SC_DATA_DIR=.swarm-state/data.
set -euo pipefail

BRANCH="swarm-state"
WT=".swarm-state"

restore() {
  git config user.name  "swarm-bot"
  git config user.email "swarm-bot@users.noreply.github.com"
  git fetch origin "$BRANCH" 2>/dev/null || true
  rm -rf "$WT"
  if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    git worktree add -f "$WT" "origin/$BRANCH"
  else
    # First ever run: create an empty orphan branch for state.
    git worktree add -f --orphan -b "$BRANCH" "$WT"
  fi
  mkdir -p "$WT/data"
  echo "state restored to $WT/data"
}

save() {
  cd "$WT"
  git add -A data
  if git diff --cached --quiet; then
    echo "no state changes to commit"
    exit 0
  fi
  git commit -m "swarm state @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # HEAD here is detached on origin/$BRANCH; push the new commit onto the branch.
  git push origin "HEAD:$BRANCH"
  echo "state saved to $BRANCH"
}

case "${1:-}" in
  restore) restore ;;
  save)    save ;;
  *) echo "usage: $0 {restore|save}" >&2; exit 2 ;;
esac
