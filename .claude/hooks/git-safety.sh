#!/usr/bin/env bash
# PreToolUse guard for `git commit` / `git push` (see CLAUDE.md > Git & Pull
# Request Policy). Defense-in-depth only — the agent must still follow the
# fetch/sync/resolve workflow itself, this hook does not replace it.
set -uo pipefail

input="$(cat)"
# JSON parsing: jq first, else any Python (python3 is not a given on Windows/Git Bash),
# else tolerant no-op — same cross-platform pattern as the global hooks.
PY="$(command -v python3 || command -v python || command -v py || true)"
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
elif [ -n "$PY" ]; then
  cmd="$(printf '%s' "$input" | "$PY" -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)"
else
  cmd=""
fi

block() {
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg reason "$1" '{decision: "block", reason: $reason}'
  elif [ -n "$PY" ]; then
    "$PY" -c "import json,sys; print(json.dumps({'decision':'block','reason':sys.argv[1]}))" "$1"
  else
    printf '{"decision":"block","reason":"Blocked by git-safety hook (see CLAUDE.md Git & Pull Request Policy)."}\n'
  fi
  exit 0
}

is_commit=false
is_push=false
printf '%s' "$cmd" | grep -Eq '(^|[;&|]|[[:space:]])git[[:space:]]+commit([[:space:]]|$)' && is_commit=true
printf '%s' "$cmd" | grep -Eq '(^|[;&|]|[[:space:]])git[[:space:]]+push([[:space:]]|$)' && is_push=true

# --- No self-attribution as co-author / AI-generated trailer -----------------
if $is_commit; then
  if printf '%s' "$cmd" | grep -Eiq 'co-authored-by:[^"'"'"']*(claude|anthropic)|generated with[^"'"'"']*claude|🤖'; then
    block "No agregues atribución de coautoría ni menciones a Claude/Anthropic en el mensaje de commit (Git & Pull Request Policy en CLAUDE.md). Quita el trailer 'Co-Authored-By' y cualquier mención a Claude/IA, y vuelve a intentar el commit."
  fi
fi

# --- Push must be in sync with origin/main, no unresolved conflicts ---------
if $is_push; then
  project_dir="${CLAUDE_PROJECT_DIR:-.}"
  if [ -d "$project_dir/.git" ]; then
    (
      cd "$project_dir" || exit 0
      base_branch="main"
      git rev-parse --verify origin/master >/dev/null 2>&1 && ! git rev-parse --verify origin/main >/dev/null 2>&1 && base_branch="master"

      git fetch origin "$base_branch" >/dev/null 2>&1

      if git rev-parse --verify "origin/$base_branch" >/dev/null 2>&1; then
        if ! git merge-base --is-ancestor "origin/$base_branch" HEAD 2>/dev/null; then
          echo "__BLOCK__Tu rama no tiene los últimos cambios de origin/$base_branch. Corre 'git fetch origin' y actualiza tu rama (rebase o merge con $base_branch) resolviendo cualquier conflicto antes de hacer push." 
          exit 0
        fi
      fi
    ) > /tmp/git-safety-push-check.$$ 2>/dev/null
    result="$(cat /tmp/git-safety-push-check.$$ 2>/dev/null || true)"
    rm -f /tmp/git-safety-push-check.$$
    if printf '%s' "$result" | grep -q '^__BLOCK__'; then
      block "${result#__BLOCK__}"
    fi
  fi
fi

echo '{}'
