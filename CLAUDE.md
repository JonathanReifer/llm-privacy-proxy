# llm-privacy-proxy — Project Standards

## Before Every Commit

1. **Scan staged changes for secrets** — `bun run check-secrets` must exit 0 (or exit 0 with warnings you've reviewed). Uses the proxy's own detection patterns. Blocks on `severity: block` matches; warns but passes on PII-only matches. To bypass intentionally: `git commit --no-verify`.
2. **Run tests** — `bun test` must pass (83 tests, 0 failures)
3. **Update version** in `package.json` if shipping a feature or fix (semver: patch for fixes, minor for features)
4. **Update CHANGELOG.md** — add entry under `[Unreleased]` or bump to a new release section
5. **Update README.md** if any user-facing behavior, env var, endpoint, or pattern changed
6. **Sync to installed copy** — `cp -r src ~/.claude/llm-privacy-proxy/` (and `package.json` if version changed)
7. **Restart proxy** after syncing — `~/.claude/llm-privacy-proxy/proxy.sh restart`
8. **Verify health** — `curl -s http://localhost:4444/health | jq .version` should return the new version

## Versioning Rules

- `package.json` `"version"` is the single source of truth
- `/health` endpoint returns it via `import pkg from "../../package.json"`
- `proxy.sh status` displays it via the `/health` response
- **Never regenerate `LLM_PRIVACY_HMAC_KEY`** — all existing vault tokens become unresolvable

## Installed Copy

The proxy runs from `~/.claude/llm-privacy-proxy/` (installed by `setup.sh`).
Source of truth is this repo. After changing any `src/` file, sync and restart:

```bash
cp -r src ~/.claude/llm-privacy-proxy/
~/.claude/llm-privacy-proxy/proxy.sh restart
curl -s http://localhost:4444/health | jq .version
```

## Known Bun Constraints

- `Bun.serve idleTimeout` max is **255 seconds** (8-bit unsigned). Never set higher — proxy crashes at startup with `ERR_INVALID_ARG_TYPE`.
- `idleTimeout: 255` is the correct default; 0 disables cleanup entirely (zombie connections).

## Testing

```bash
bun test                    # unit + integration (83 tests)
bun test --watch            # re-run on change
```

No mocks for the vault — tests use a real in-memory `MemoryVault`. Keep it that way.

## Adding Patterns

New detection patterns require changes in two files:
1. `src/types.ts` — add to the `PatternType` union
2. `src/core.ts` — append to the `PATTERNS` array

Then add the pattern to the README table and CHANGELOG.

## Adding Vault / API Changes

Any schema change to `vault.db` must be done via `ALTER TABLE` with `try/catch` (SQLite throws if column exists). Never `DROP` or recreate tables.

New proxy endpoints go in `src/proxy/server.ts` `handleRequest()` and must be documented in README under the relevant section.
