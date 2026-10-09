# Contributing to DBAgent

## Setup

Requires Node.js ≥ 22.5 (built-in `node:sqlite`; older Node falls back to `better-sqlite3`).

```bash
npm install
cp .env.example .env    # add at least one provider API key
npm run demo:seed       # create demo.db (gitignored; CI seeds it too)
npm test                # full suite — must be green before you push
```

## Day-to-day commands

| Command                                   | What it does                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                             | run the CLI from source (tsx, no build)                                                                        |
| `npm run build`                           | compile `src/` to `dist/` (also runs on `npm publish`)                                                         |
| `npm run typecheck`                       | strict TypeScript check                                                                                        |
| `npm run lint`                            | ESLint (0 errors; the pre-existing unused-var warnings are tolerated)                                          |
| `npm run format` / `npm run format:check` | Prettier write / check (CI enforces check)                                                                     |
| `npm test`                                | full suite: typecheck + 9 smoke/e2e suites (mocked LLMs, real SQLite; needs `demo.db` — run `demo:seed` first) |

## Contribution rules

1. **One commit per piece of work**, with a message explaining _why_ (not just _what_).
2. Keep `typecheck`, `lint` (0 errors) and `format:check` green.
3. New agent tools need: driver coverage for all 4 dialects where applicable, a system-prompt line so the model actually uses the tool, README docs (tools table + safety/config if gated), and smoke coverage in `scripts/`.
4. Never weaken a guardrail silently: DDL blocks, write confirmation and PII masking are load-bearing. Changes there need explicit justification in the commit message.
5. Test scripts live in `scripts/` and run against `demo.db` — never commit `*.db`, `dist/`, `dbagent-out/` or `tmp-*` files (all gitignored).

## Release process

1. Bump the version (this also creates the git tag — `cli --version` reads it from `package.json`, single source of truth):
   ```bash
   npm version patch   # or minor / major
   git push --follow-tags
   ```
2. Pushing tag `v*` triggers the `release` workflow: clean install → seed → **full `npm test`** → `npm publish`. The tag must match `package.json` (`v0.2.0` ↔ `0.2.0`), otherwise the workflow fails fast.
3. One-time setup for publishing: create a granular npm access token and store it as the `NPM_TOKEN` repository secret (Settings → Secrets → Actions). The `dbagent` name on npm is currently free — the first publish claims it, so coordinate before running it.

To inspect exactly what would be published without uploading:

```bash
npm pack --dry-run   # expect only dist/, README.md, LICENSE, package.json
```
