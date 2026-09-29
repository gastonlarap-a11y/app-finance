#!/usr/bin/env bash
# PreToolUse guard for `git commit` / `git push` (see AGENTS.md › Git).
# Defense-in-depth only — the agent must still follow the fetch/sync/resolve
# workflow itself, this hook does not replace it.
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

# PreToolUse denies through hookSpecificOutput (top-level `decision` is not its schema).
block() {
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg reason "$1" \
      '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
  elif [ -n "$PY" ]; then
    "$PY" -c "import json,sys; print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':sys.argv[1]}}))" "$1"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by git-safety hook (see AGENTS.md › Git)."}}\n'
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
    block "No agregues atribución de coautoría ni menciones a Claude/Anthropic en el mensaje de commit (AGENTS.md › Git). Quita el trailer 'Co-Authored-By' y cualquier mención a Claude/IA, y vuelve a intentar el commit."
  fi
fi

# --- Push must be in sync with origin/main, no unresolved conflicts ---------
if $is_push; then
  project_dir="${CLAUDE_PROJECT_DIR:-.}"
  if [ -d "$project_dir/.git" ]; then
    result="$(
      exec 2>/dev/null
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
    )" || true
    if printf '%s' "$result" | grep -q '^__BLOCK__'; then
      block "${result#__BLOCK__}"
    fi
  fi
fi

echo '{}'
