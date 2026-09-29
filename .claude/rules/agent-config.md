---
paths:
  - "AGENTS.md"
  - "CLAUDE.md"
  - ".claude/**"
  - ".agents/**"
  - ".codex/**"
  - ".mcp.json"
---

# Agent configuration

- `AGENTS.md` is canonical for every agent and holds only repo-wide facts (hard cap 150 lines —
  it is always loaded); area invariants go to a `paths:`-scoped file here, listed in its
  "Area rules" index.
- Skills: canonical files in `.agents/skills/` (Codex + Antigravity read them there);
  `.claude/skills/*/SKILL.md` are symlinks to them — edit the canonical file.
- Never add a `permissions.deny` `Read(...)` rule for a file a build or test reads (`*.local.go`,
  `bin/`, `frontend/dist/`, `frontend/bindings/`, embed dirs): deny rules feed the Bash sandbox, so
  they silently break `go build/vet/test` and `tsc` in-session while CI stays green. Deny only
  runtime secrets (`.env`, tokens, `config.toml`, `*.pem`); gitleaks in CI guards the rest.
- Anchor root-only paths with a leading `/` (`/config.toml`): a bare name matches at any depth in
  both `.gitignore` and permission rules — unanchored, it hid and blocked `.codex/config.toml`.
- PreToolUse hooks answer with `hookSpecificOutput.permissionDecision` (`deny` + reason); the
  top-level `decision` field is for Stop/PostToolUse-style events.
- Codex mirrors Claude's project config by hand: `.codex/config.toml` (MCP servers — Codex does
  not read `.mcp.json`) and `.codex/hooks.json` (the Stop gate).
