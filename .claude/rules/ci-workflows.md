---
paths:
  - ".github/**"
---

# GitHub Actions workflows (`.github/workflows/`)

- Every action is pinned to a full commit SHA with its tag in a comment (Dependabot bumps both);
  checkouts use `persist-credentials: false`; each job has `timeout-minutes` and the least
  `permissions` it needs.
- `release.yml` builds read-only and without caches (cache poisoning), checks the tag is on main,
  and only its `publish` job can write. `deploy-web.yml` runs after a successful CI of a push to main.
- Validate edits with `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`. Tool versions
  are pinned, never `@latest`.
