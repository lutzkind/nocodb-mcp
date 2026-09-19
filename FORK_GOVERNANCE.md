# Fork governance — `lutzkind/nocodb-mcp`

Applies to the maintained fork `lutzkind/nocodb-mcp` of `zoyak-tech/nocodb-mcp`
(upstream `main`: `1944af1919ec85e9d4b6674d2b8a0edb5e5762a0`, tag `v1.0.7`).
Verified against the live GitHub API and remotes on **2026-09-19**; fork `main`
was `88341f0cdd5c4eca49c644022dd3843dc829dd4d`. This file closes audit finding
PA-61 ("personal/main gone; residual fork-vs-upstream overlap").

## 1. Canonical branch model

| Ref | Role | Rules |
|---|---|---|
| `main` | **Canonical fork branch and default branch** | Everything ships from here. Integration via PR only; direct pushes discouraged. |
| `upstream-sync/YYYYMMDD` | Upstream integration branch | Created by `scripts/upstream-sync.sh` / `Upstream Sync` workflow; PRs target `main`; automation never pushes `main`. |
| `codex/mcp-defect-fixes` | Retained legacy branch — see §5 | Not contained in `main`; zero-loss policy keeps it until PR #1 is dispositioned. |

The historical `personal/main` ref **no longer exists**. Verified 2026-09-19 with
`gh api repos/lutzkind/nocodb-mcp/branches` and `git ls-remote` (only `main` and
`codex/mcp-defect-fixes` remain), and `origin/HEAD -> origin/main`. Do not
recreate `personal/*` refs: the canonical name is `main`.

## 2. Ownership map (what is local vs upstream)

| Divergent area | Owner | Authoritative source | Primary paths |
|---|---|---|---|
| Guarded record mutations: preview binding, `expected_*` target checks | **fork maintainers** | fork `main` (`06c799b`, `88341f0`) | `src/tools/records.ts`, `src/tools/helpers.ts`, `tests/records-target-binding.test.ts` |
| Consolidated schema writes, record history reads, metadata resolution | **fork maintainers** | fork `main` (PR #2 squash `06c799b`) | `src/tools/schema-write.ts`, `src/tools/history.ts`, `src/tools/metadata-resolution.ts`, `src/server.ts` |
| NocoDB v3 record payload/wire shaping | upstream `zoyak-tech` | upstream `d821d9f` | `src/record-payload.ts`, `src/client.ts`, `src/config.ts`, `tests/record-payload.test.ts` |
| Runtime version resolution (package.json at runtime) | upstream `zoyak-tech` | upstream `1944af1` | `src/version.ts`, `src/index-stdio.ts`, `package.json` |
| Base tool surface (19 groups, 92+ tools) and all other files | upstream `zoyak-tech` | upstream `main` | everything not listed above |

## 3. Divergence register (revalidated 2026-09-19)

- Merge base: `ff78c7c` (`v1.0.5`, 2026-07-05).
- Fork-only commits on `main`: `06c799b` (2026-07-21, guarded record mutation tools), `88341f0` (2026-07-28, conditional update preview binding).
- Upstream-only commits: `d821d9f` (record write shaping), `1944af1` (runtime version).
- Drift: **2 fork commits vs 2 upstream commits**, nothing merged. This is the
  PA-61 "residual fork-vs-upstream overlap": both sides reworked record writes
  after `v1.0.5`; upstream added `src/record-payload.ts` and `src/version.ts`,
  the fork reworked `src/tools/records.ts` around guarded preview binding.
- Operational maintenance item: run the upstream sync workflow and resolve the
  `src/tools/records.ts` overlap per §4. Not merged by the governance change
  (task constraint: no large upstream merge attempted).

## 4. Conflict policy (upstream sync)

1. Integration happens only on `upstream-sync/YYYYMMDD` branches; automation never
   pushes to `main`. Merging to `main` is a human PR decision.
2. Upstream wins for NocoDB v3 wire contracts: `src/record-payload.ts`,
   `src/client.ts`, `src/config.ts`, version handling.
3. The fork wins for guarded mutation semantics: preview binding / `expected_*`
   verification in `src/tools/records.ts` and the schema-write/history/metadata
   tool surface must be preserved by re-applying guard checks on top of upstream
   shaping.
4. `src/tools/records.ts` conflicts: take upstream transport/shaping first, then
   re-apply the fork guard layer; do not silently drop `expected_*` parameters.
5. Generated or shared metadata (`package.json` version, `package-lock.json`,
   `CHANGELOG.md`): take upstream, regenerate the lockfile with npm if needed, and
   keep the fork CHANGELOG entry above upstream entries.
6. Acceptance gate before merging the sync PR:
   `npm run typecheck && npm run lint && npm test && npm run build`.

## 5. Branch inventory and cleanup (2026-09-19)

Deletion criteria (zero-loss only): branch tip is fully contained in `main`,
verified with `gh api repos/.../compare/main...<branch>` showing `ahead_by: 0`.
No branch met the criteria, so **nothing was deleted** in this repo.

| Branch | Tip | Status | Disposition |
|---|---|---|---|
| `main` | `88341f0` | canonical/default | keep |
| `codex/mcp-defect-fixes` | `ceaf2b7` | PR #1 OPEN, `CONFLICTING`; 2 commits not in `main`; content functionally superseded by merged PR #2 (`schema-write.ts`, `history.ts`, `metadata-resolution.ts` reworked on `main`) | **retained** per zero-loss policy; recommend maintainers close PR #1 and delete afterwards |

`refs/pull/1/*` and `refs/pull/2/*` are GitHub PR refs, not branches; not
deletable through the branches API and intentionally untouched.

## 6. Upstream sync mechanism

- **Script**: `scripts/upstream-sync.sh` — fetches `upstream/main`, creates
  `upstream-sync/YYYYMMDD` from `origin/main`, attempts merge (`--mode rebase`
  available), records conflicts in `UPSTREAM_SYNC_CONFLICTS.md` with
  `--report-conflicts`, pushes with `--push`, opens a PR against `main` with
  `--pr`. Refuses to run on `main` and refuses non-fast-forward pushes.
- **Workflow**: `.github/workflows/upstream-sync.yml` — `workflow_dispatch`
  (merge/rebase choice) plus a monthly schedule; `contents: write` +
  `pull-requests: write` only; `actions/checkout` pinned to
  `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1). The workflow only pushes
  `upstream-sync/<date>` and opens a PR.
- **Upstream remote**: `https://github.com/zoyak-tech/nocodb-mcp.git`, added as
  remote `upstream` (the script adds/updates it idempotently).
- **Cadence**: monthly on the first business day (scheduled run), plus within
  5 business days of an upstream release tag; dispatch manually any time.
- `workflow_dispatch` becomes available once this workflow is merged to the
  default branch (`main`). The scheduled run follows the same path.

## 7. Known gaps / recommendations

- `main` is **not branch-protected** (verified `404` on 2026-09-19). Recommend a
  ruleset requiring PR review and the CI checks before merge.
- `.github/workflows/ci.yml` still uses tag-pinned actions
  (`actions/checkout@v4`, `actions/setup-node@v4`); SHA-pinning is recommended
  but out of scope for PA-61.
- The upstream sync branch is dated; a same-day rerun must delete the previous
  `upstream-sync/YYYYMMDD` branch first (the script refuses to overwrite).
