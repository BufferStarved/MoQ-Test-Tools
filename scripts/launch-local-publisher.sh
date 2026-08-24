#!/usr/bin/env bash
# Find or clone MoQ-Test-Tools, then start the laptop helper.
# Safe to paste from ~ — does not require cwd to be the repo.
set -euo pipefail

SCRIPT_REL="scripts/run-local-publisher.sh"
CLONE_DEST="${MOQ_TEST_TOOLS:-$HOME/moq-test-tools}"
CLONE_REPO="${MOQ_TEST_TOOLS_REPO:-https://github.com/BufferStarved/MoQ-Test-Tools.git}"
CLONE_REF="${MOQ_TEST_TOOLS_REF:-feat/moq-draft-18}"

try_exec() {
  local root="$1"
  [[ -n "$root" ]] || return 1
  local candidate="$root/$SCRIPT_REL"
  if [[ -x "$candidate" || -f "$candidate" ]]; then
    exec bash "$candidate"
  fi
  return 1
}

walk_up() {
  local here="$1"
  while :; do
    try_exec "$here" && return 0
    [[ "$here" == / ]] && return 1
    local parent="${here%/*}"
    [[ -n "$parent" ]] || parent=/
    here="$parent"
  done
}

for d in \
  ${MOQ_TEST_TOOLS:+"$MOQ_TEST_TOOLS"} \
  "$PWD" \
  "$HOME/Developer/moq-test-tools" \
  "$HOME/Developer/MoQ-Test-Tools" \
  "$HOME/src/moq-test-tools" \
  "$HOME/code/moq-test-tools" \
  "$HOME/moq-test-tools"
do
  try_exec "$d" || true
done

walk_up "$PWD" || true

if [[ -x "$CLONE_DEST/$SCRIPT_REL" || -f "$CLONE_DEST/$SCRIPT_REL" ]]; then
  exec bash "$CLONE_DEST/$SCRIPT_REL"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "No MoQ-Test-Tools checkout found, and git is not installed." >&2
  echo "Clone https://github.com/BufferStarved/MoQ-Test-Tools and paste the command again." >&2
  exit 1
fi

echo "No checkout found — cloning $CLONE_REF into $CLONE_DEST" >&2
git clone --depth 1 --branch "$CLONE_REF" "$CLONE_REPO" "$CLONE_DEST"
exec bash "$CLONE_DEST/$SCRIPT_REL"
