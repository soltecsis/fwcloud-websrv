# FWCloud Websrv CI

Continuous integration for FWCloud Websrv runs on GitHub Actions and is defined in
[`.github/workflows/nodejs.yml`](workflows/nodejs.yml). It checks code quality, builds the
application and runs the test suite on every supported Node.js version. It keeps the test
and coverage reports as workflow artifacts. It then reports a single result, `websrv-ci`,
which branch protection can use as the required check.

## Workflow overview

```text
FWCloud Websrv CI
│
├── quality                  Node.js 22: npm ci → lint:check → format:check → test:ci-tools
│
├── test (Node.js 20)        npm ci → build → test:ci          → ci:reports → upload test reports
├── test (Node.js 22)        npm ci → build → test:coverage:ci → ci:reports → upload test and coverage reports
├── test (Node.js 24)        npm ci → build → test:ci          → ci:reports → upload test reports
│
└── websrv-ci                Passes only if every job above succeeded
```

`quality` and the `test` matrix run in parallel. `websrv-ci` waits for all of them.

| Job                      | Purpose                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `quality`                | ESLint, Prettier and tests of the report tooling, run once on Node.js 22.       |
| `test (Node.js <x>)`     | Clean install, build, Jest tests and test reports on one Node.js version.       |
| `test (Node.js 22)`      | Also the reference coverage run. See [Test and coverage reports](#test-and-coverage-reports). |
| `websrv-ci`              | Aggregates the results of all required jobs.                                    |

The workflow does not deploy or publish anything outside the run. Reports are only
available as artifacts of the workflow run.

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
repository, issues, pull requests, packages or releases. Uploading workflow artifacts
needs no extra permission. If a future job needs more access, grant it on that job only.

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

| Version | `quality` | `test` | Reference coverage |
| ------- | :-------: | :----: | :----------------: |
| 20      |           |   ✔    |                    |
| 22      |     ✔     |   ✔    |         ✔          |
| 24      |           |   ✔    |                    |

`quality` runs only on Node.js 22. The `test` matrix uses `fail-fast: false`, so one
failing version does not cancel the others. Each version is reported as its own check
(`test (Node.js 20)`, `test (Node.js 22)`, `test (Node.js 24)`).

To change the supported versions, edit `matrix.node-version` in the workflow and update
this table. The `websrv-ci` check name does not change, so branch protection rules do
not need updating. The reference coverage version is set once, in the `COVERAGE_EXPECTED`
variable of the `test` job.

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

| Check          | Command                 | Scope                                                                             |
| -------------- | ----------------------- | --------------------------------------------------------------------------------- |
| ESLint         | `npm run lint:check`    | `{src,app,lib,tests,config,test}/**/*.ts`                                         |
| Prettier       | `npm run format:check`  | `{src,app,lib,tests,config,test,scripts}/**/*.{ts,cjs,json,yml,yaml}` (`--check`) |
| Report tooling | `npm run test:ci-tools` | `scripts/*.test.cjs`, run with the Node.js test runner (`node --test`)            |

These checks only report problems. They never change files.

ESLint only covers TypeScript: its type-aware rules need every file to be part of the
`tsconfig.json` project, which does not include JavaScript. The CI scripts in `scripts/`
are only checked by Prettier and by their own tests. Other files under `config/`,
such as the systemd unit and SELinux policy in `config/sys/`, are not supported by either
tool and are not checked. Prettier also skips anything listed in `.gitignore`, such as the
TLS certificates in `config/tls/`.

## Test and coverage reports

Every `test` job produces machine-readable test reports. The Node.js 22 job also measures
coverage and records the reference coverage baseline. Report generation never changes the
test result: a failing test still fails its job.

### Commands and files

| Item                          | Purpose                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `npm run test:ci`             | Jest with the default console reporter, `jest-junit` and Jest's JSON results.      |
| `npm run test:coverage:ci`    | The same single test run, with coverage enabled.                                   |
| `npm run ci:reports`          | Runs `scripts/ci-reports.cjs`: validates the reports, writes metadata and baseline. |
| `npm run test:ci-tools`       | Tests of `scripts/ci-reports.cjs`.                                                 |
| `jest-junit` in `package.json` | JUnit output path and format. Suites that fail to run are reported as errors.     |

`npm test` and `npm run test:cov` are unchanged and write no JUnit, JSON results or
baseline. All these commands share the Jest configuration in `package.json`, including
the coverage scope (`collectCoverageFrom`). The CI scripts only add reporters on the
command line; `test:coverage:ci` selects the `json`, `json-summary`, `lcov` and `text`
coverage reporters. `jest-junit` is pinned to an exact version in `package.json`.

`scripts/ci-reports.cjs` is adapted from `fwcloud-api` (`scripts/ci-reports.cjs`). That
version reads Mocha and c8 reports; this one reads Jest reports, adds the coverage
baseline and drops the database fields.

### Generated reports

```text
reports/
├── metadata.json            Every job: commit, run, Node.js/npm versions, test counters, errors
├── jest/
│   ├── junit.xml            JUnit XML (jest-junit)
│   └── results.json         Jest JSON results (--json)
└── coverage/                Node.js 22 only, and only when the run is complete
    ├── baseline.json        Reference coverage metadata
    └── lcov.sha256          SHA-256 of coverage/lcov.info, in sha256sum format

coverage/                    Node.js 22 only (Jest coverageDirectory)
├── lcov.info                LCOV, with source paths relative to the repository root (SF:src/...)
├── coverage-final.json      Istanbul per-file coverage
├── coverage-summary.json    Totals used for the baseline metrics
└── lcov-report/             HTML report (open index.html)
```

`reports/` and `coverage/` are listed in `.gitignore`.

### Validation and failure handling

The `Run tests` step does not use `continue-on-error`, so a test failure fails the job.
The next steps run with `!cancelled()` when the tests started, including after a test
failure:

1. `Verify reports and summarize results` runs `npm run ci:reports`.
2. `Upload test reports` publishes the test reports.
3. `Upload coverage reports` publishes the coverage reports (Node.js 22 only).

If the install or build fails, the tests never start and no report is produced or
uploaded. `ci:reports` fails, and writes the errors to `reports/metadata.json`, when:

- `junit.xml` or `results.json` is missing, empty or malformed;
- Jest reports no tests, a failed test or a test suite that failed to run (for example,
  a compilation error);
- the test step did not succeed (`TEST_OUTCOME`), whatever the reports say;
- on the reference run, `lcov.info`, `coverage-final.json` or `coverage-summary.json` is
  missing or invalid, or the coverage contains no source lines.

It also adds a summary to the job page with aggregate figures only: test counters,
coverage percentages, the LCOV checksum and the errors. Test names, failure messages and
source code stay in the artifacts. Review them before sharing artifacts outside the
project: the JUnit and JSON reports contain test names and stack traces, and the HTML
coverage report contains source code.

The coverage baseline (`reports/coverage/`) is only written when the reference run is
complete: tests passed and all coverage reports are valid. A failed reference run still
uploads its coverage reports for inspection, but without `baseline.json` or
`lcov.sha256`, so it cannot be mistaken for a baseline. `ci:reports` deletes any previous
`reports/coverage/` before validating, so a stale baseline never describes new reports.

### Artifacts

Artifacts are uploaded with `actions/upload-artifact@v7` and `if-no-files-found: error`.
They are kept for the repository's default artifact retention period (90 days unless
changed in the repository settings). Download them from the **Artifacts** section of
the workflow run summary.

| Artifact                                       | Produced by        | Contents                                          |
| ---------------------------------------------- | ------------------ | ------------------------------------------------- |
| `websrv-tests-node<NODE>-<RUN_ID>-<ATTEMPT>`   | Every `test` job   | `jest/junit.xml`, `jest/results.json`, `metadata.json` |
| `websrv-coverage-node22-<RUN_ID>`              | `test (Node.js 22)` | `coverage/`, `reports/coverage/`                   |

- Each Node.js version uploads its own test artifact, and each run attempt gets new
  names, so matrix jobs and re-runs never overwrite each other's test reports.
- There is one coverage artifact per run. Re-running the Node.js 22 job replaces it
  (`overwrite: true`), so the artifact always matches that job's latest attempt.
  `baseline.json` records the attempt in `runAttempt`.

### Reference coverage baseline

Coverage is measured on Node.js 22 only, on every run of the workflow (every push and
pull request on the [trigger branches](#triggers)). The suite runs once in that job, with
coverage enabled. Paths that only run on other Node.js versions are not reflected in the
baseline.

`reports/coverage/baseline.json` contains `reports/metadata.json` plus the LCOV file
details:

| Field                    | Content                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `generatedAt`            | Report generation timestamp (ISO 8601, UTC).                                    |
| `commit`                 | Checked-out commit. On pull requests, GitHub's test merge commit.               |
| `pullRequestHeadCommit`  | Head commit of the pull request branch, or `null` on pushes.                    |
| `repository`, `event`, `ref`, `runId`, `runAttempt` | GitHub run that produced the baseline.               |
| `node`, `npm`            | Exact Node.js and npm versions.                                                 |
| `tests`                  | Jest test and suite counters.                                                   |
| `coverage`               | `lines`, `statements`, `functions` and `branches`: `total`, `covered`, `skipped`, `pct`. |
| `lcov`                   | `path` (`coverage/lcov.info`) and `sha256` of that exact file.                  |

| Metric       | What it measures                                                    |
| ------------ | ------------------------------------------------------------------- |
| `lines`      | Executable lines run at least once by the tests.                    |
| `statements` | Statements run; one line may contain several statements.            |
| `functions`  | Functions called at least once.                                     |
| `branches`   | Branch paths taken, such as each side of an `if` or a ternary.      |

Coverage shows which code the tests ran, not whether they checked its behavior. 60 % line
coverage means 60 % of the lines were executed, not that 60 % of the code is correct.
No minimum percentage is enforced: the baseline is a reference to find untested code and
compare runs. At the time of writing, the baseline on Node.js 22 was 18.93 % lines,
20 % statements, 6.66 % functions and 7.89 % branches; most of `websrv.service.ts`
(proxy, static files and HTTPS) is not covered.

### Verifying and comparing baselines

The checksum identifies the exact LCOV file published by a run and lets you check its
integrity. It is expected to change between commits whenever the code or the tests change.
After downloading and extracting a coverage artifact:

```bash
sha256sum -c reports/coverage/lcov.sha256
# coverage/lcov.info: OK
```

The same value appears in `baseline.json` (`lcov` → `sha256`) and in the `LCOV SHA-256`
line of the job summary. To compare two runs, compare the `coverage` objects of their
`baseline.json` files, and check `commit` and `node` first to confirm what each one
measured. Two baselines with the same checksum were produced from identical LCOV files.

## Running CI locally

Run the same commands as CI from the repository root. `npm ci` deletes `node_modules`
and reinstalls it from the lockfile.

```bash
# quality job (Node.js 22)
npm ci
npm run lint:check
npm run format:check
npm run test:ci-tools

# test job (current Node.js version)
npm ci
npm run build
npm run test:ci
TEST_OUTCOME=success npm run ci:reports

# reference coverage (Node.js 22)
npm ci
npm run build
npm run test:coverage:ci
TEST_OUTCOME=success COVERAGE_EXPECTED=true npm run ci:reports
sha256sum -c reports/coverage/lcov.sha256
```

`TEST_OUTCOME` tells `ci:reports` how the test command ended; in CI it comes from the
test step. Pass `TEST_OUTCOME=failure` to validate and summarize the reports of a failed
run. Without it, `ci:reports` treats the outcome as unknown and fails. Locally, `commit`
is your checked-out `HEAD` and the GitHub run fields are `null`.

To reproduce the full matrix with [nvm](https://github.com/nvm-sh/nvm):

```bash
for v in 20 22 24; do
  nvm install "$v" && nvm use "$v" \
    && npm ci && npm run build && npm run test:ci \
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
| Tests fail on only one Node.js version | Reproduce on that version: `nvm use <version> && npm ci && npm run build && npm run test:ci`. Failure details are in that job's `websrv-tests-node<version>-...` artifact. |
| `Verify reports and summarize results` fails after `Run tests` failed | Expected: the reports were still validated and uploaded. Fix the failing tests; the errors are listed in the job summary and in `metadata.json`. |
| `Verify reports and summarize results` fails but `Run tests` passed | A report is missing or invalid, or Jest reported no tests. The error is listed in the job summary. Reproduce with the commands in [Running CI locally](#running-ci-locally). |
| `quality` fails on `Test CI report tooling` | A change broke `scripts/ci-reports.cjs` or its tests. Run `npm run test:ci-tools` locally. |
| The coverage artifact has no `baseline.json` | The Node.js 22 run failed or its coverage was invalid, so no baseline was recorded. See that job's summary. |
| `sha256sum -c reports/coverage/lcov.sha256` fails | `coverage/lcov.info` is not the file the baseline was recorded for. Download the artifact again, unmodified. |
| `websrv-ci` fails but no job failed | A required job was cancelled or skipped. Check the job list in the run summary, then re-run the workflow. A cancelled run on an old commit can be ignored if a newer run exists. |
| `websrv-ci` stays at "Expected — Waiting for status to be reported" | The workflow did not run for that commit. Usually the PR targets a branch that is not listed in [Triggers](#triggers). |
| `websrv-ci` does not appear when configuring branch protection | The check has not run in the last 7 days. Open or update a pull request against one of the trigger branches first. |
