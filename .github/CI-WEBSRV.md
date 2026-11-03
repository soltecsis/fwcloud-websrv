# FWCloud Websrv CI

Continuous integration for FWCloud Websrv runs on GitHub Actions and is defined in
[`.github/workflows/nodejs.yml`](workflows/nodejs.yml). It checks code quality, builds the
application and runs the test suite on every supported Node.js version. It then reports a
single result, `websrv-ci`, which branch protection can use as the required check.

## Workflow overview

```text
FWCloud Websrv CI
│
├── quality                  Node.js 22: npm ci → lint:check → format:check
│
├── test (Node.js 20)        npm ci → build → test
├── test (Node.js 22)        npm ci → build → test
├── test (Node.js 24)        npm ci → build → test
│
└── websrv-ci                Passes only if every job above succeeded
```

`quality` and the `test` matrix run in parallel. `websrv-ci` waits for all of them.

| Job                      | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `quality`                | ESLint and Prettier checks, run once on Node.js 22.            |
| `test (Node.js <x>)`     | Clean install, build and Jest tests on one Node.js version.     |
| `websrv-ci`              | Aggregates the results of all required jobs.                   |

The workflow does not deploy or publish anything.

## Triggers

| Event          | Branches         |
| -------------- | ---------------- |
| `push`         | `main`, `devel`, `ENS` |
| `pull_request` | `main`, `devel`, `ENS` |

Pushes to other branches, such as feature branches, do not start the workflow. To run CI
for a feature branch, open a pull request against one of these branches.

Branch names are case-sensitive: `ENS` must be written in upper case.

## Permissions

The workflow sets `permissions: contents: read` at the top level. Every job gets a
read-only `GITHUB_TOKEN`, which is enough to check out the code. No job can write to the
repository, issues, pull requests, packages or releases. If a future job needs more
access, grant it on that job only.

## Concurrency

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

- Pull requests are grouped by PR number. A new push to a PR cancels that PR's previous
  run.
- Pushes are grouped by branch (`refs/heads/main`, `refs/heads/devel`, `refs/heads/ENS`).
  A new push to a branch cancels the previous run on that branch.
- Runs for different PRs or branches never cancel each other. A push to `devel` and a PR
  that targets `devel` are also in separate groups.

A superseded run ends as **cancelled**. Its `websrv-ci` job still runs and reports a
failure on the old commit, because a cancelled job is never treated as a pass. This does
not block anything: branch protection only looks at the PR's latest commit, and the newer
run reports `websrv-ci` for that commit. A pass on cancellation would let a manually
cancelled run satisfy the required check without running the tests.

## Node.js versions

| Version | `quality` | `test` |
| ------- | :-------: | :----: |
| 20      |           |   ✔    |
| 22      |     ✔     |   ✔    |
| 24      |           |   ✔    |

`quality` runs only on Node.js 22. The `test` matrix uses `fail-fast: false`, so one
failing version does not cancel the others. Each version is reported as its own check
(`test (Node.js 20)`, `test (Node.js 22)`, `test (Node.js 24)`).

To change the supported versions, edit `matrix.node-version` in the workflow and update
this table. The `websrv-ci` check name does not change, so branch protection rules do
not need updating.

## Dependency installation and caching

- Every job installs dependencies with `npm ci`. It installs exactly what
  `package-lock.json` specifies, never writes the lockfile, and fails if `package.json`
  and `package-lock.json` disagree.
- Each `test` job then runs `git diff --exit-code -- package-lock.json` to confirm the
  lockfile was not modified.
- `actions/setup-node` with `cache: npm` caches the npm download cache (`~/.npm`), using
  the hash of `package-lock.json` as the key. `node_modules` is never cached, so every run
  starts from a clean install.

## Quality checks

| Check    | Command                | Scope                                                                 |
| -------- | ---------------------- | --------------------------------------------------------------------- |
| ESLint   | `npm run lint:check`   | `{src,app,lib,tests,config,test}/**/*.ts`                             |
| Prettier | `npm run format:check` | `{src,app,lib,tests,config,test}/**/*.{ts,json,yml,yaml}` (`--check`) |

Both checks only report problems. They never change files.

ESLint only covers TypeScript: its type-aware rules need every file to be part of the
`tsconfig.json` project, which does not include JavaScript. Other files under `config/`,
such as the systemd unit and SELinux policy in `config/sys/`, are not supported by either
tool and are not checked. Prettier also skips anything listed in `.gitignore`, such as the
TLS certificates in `config/tls/`.

## Running CI locally

Run the same commands as CI from the repository root. `npm ci` deletes `node_modules`
and reinstalls it from the lockfile.

```bash
# quality job (Node.js 22)
npm ci
npm run lint:check
npm run format:check

# test job (current Node.js version)
npm ci
npm run build
npm test
```

To reproduce the full matrix with [nvm](https://github.com/nvm-sh/nvm):

```bash
for v in 20 22 24; do
  nvm install "$v" && nvm use "$v" \
    && npm ci && npm run build && npm test \
    || { echo "Failed on Node.js $v"; break; }
done
```

To fix lint or formatting problems automatically:

```bash
npm run lint:fix
npm run format:fix
```

## Required status check

Use `websrv-ci` as the only required check for each protected branch listed in
[Triggers](#triggers). Do not require the
individual `quality` or `test (Node.js <x>)` checks: their names change when the matrix
changes, while `websrv-ci` stays the same.

`websrv-ci` uses `if: always()`, so it runs even when a job it depends on fails. It
succeeds only if every job in its `needs` list ends with `success`. A result of
`failure`, `cancelled` or `skipped` makes it fail. When adding a new required job, add it
to `needs`. The result check covers it automatically.

To configure it (repository admin):

1. Go to **Settings → Branches** and add or edit a branch protection rule for each
   protected branch. With rulesets, use **Settings → Rules → Rulesets** instead.
2. Enable **Require status checks to pass before merging**.
3. Search for `websrv-ci` and add it. GitHub only lists checks that have run in the last
   7 days, so the workflow must have run at least once (for example, on a pull request).
4. Save the rule.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `npm ci` fails with `package.json and package-lock.json ... are not in sync` | The lockfile is out of date. Run `npm install` locally and commit the updated `package-lock.json`. |
| `Verify package-lock.json is unchanged` fails | Something changed the lockfile during installation. Run `npm ci` locally and check `git diff package-lock.json`. |
| `quality` fails on ESLint or Prettier | Run `npm run lint:check` and `npm run format:check` locally. Fix with `npm run lint:fix` and `npm run format:fix`, then commit. |
| Tests fail on only one Node.js version | Reproduce on that version: `nvm use <version> && npm ci && npm run build && npm test`. |
| `websrv-ci` fails but no job failed | A required job was cancelled or skipped. Check the job list in the run summary, then re-run the workflow. A cancelled run on an old commit can be ignored if a newer run exists. |
| `websrv-ci` stays at "Expected — Waiting for status to be reported" | The workflow did not run for that commit. Usually the PR targets a branch that is not listed in [Triggers](#triggers). |
| `websrv-ci` does not appear when configuring branch protection | The check has not run in the last 7 days. Open or update a pull request against one of the trigger branches first. |
