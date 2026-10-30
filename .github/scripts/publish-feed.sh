#!/usr/bin/env bash
# Copies .feed/*.json onto the "feed" branch and pushes, only when something
# changed. Retries if another workflow pushed first. Pushes made with
# GITHUB_TOKEN don't trigger other workflows.
set -euo pipefail

SRC="${GITHUB_WORKSPACE}/.feed"
[ -d "$SRC" ] || { echo "no feed files"; exit 0; }
REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

for attempt in 1 2 3; do
  WORK="$(mktemp -d)"
  cd "$WORK"
  if git ls-remote --exit-code --heads "$REMOTE" feed >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch feed "$REMOTE" .
  else
    git init --quiet -b feed .
    git remote add origin "$REMOTE"
    printf '# feed\n\nMachine-readable output of the watcher: `alerts.json` (alerts from the last 48 hours) and `rundown.json` (the latest daily rundown).\n' > README.md
  fi
  cp "$SRC"/*.json .
  # channel feeds live in subfolders (rivals/, tokon/)
  for d in "$SRC"/*/; do [ -d "$d" ] && mkdir -p "$(basename "$d")" && cp "$d"*.json "$(basename "$d")"/ 2>/dev/null || true; done
  git add -A
  if git diff --cached --quiet; then
    echo "feed unchanged"
    exit 0
  fi
  git -c user.name="esports-news-watch" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "feed update"
  if git push --quiet origin feed; then
    echo "feed published"
    exit 0
  fi
  echo "push raced with another run, retrying ($attempt)"
  sleep $((attempt * 3))
done
echo "could not publish feed"
exit 1
