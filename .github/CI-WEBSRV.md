# FWCloud Websrv CI

Continuous integration for FWCloud Websrv runs on GitHub Actions and is defined in
[`.github/workflows/nodejs.yml`](workflows/nodejs.yml). It checks code quality, builds the
application, scans the complete available Git history for secrets, checks dependency
vulnerabilities and runs the test suite on every supported Node.js version. It keeps test,
coverage, safe secret scan metadata, dependency reports and a Software Bill of Materials
(SBOM) as workflow artifacts. It then reports a single result, `websrv-ci`,
which branch protection can use as the required check.

## Workflow overview

```text
FWCloud Websrv CI
│
├── quality                  Node.js 22: npm ci → lint:check → format:check → test:ci-tools
│
├── gitleaks                 Full checkout → verified Gitleaks → detector regression → full-history scan
│
├── trivy                    Verified Trivy → dependency scan → CycloneDX SBOM → HIGH/CRITICAL gate → upload evidence
│
├── test (Node.js 20)        npm ci → build → test:ci          → ci:reports → upload test reports
├── test (Node.js 22)        npm ci → build → test:coverage:ci → ci:reports → upload test and coverage reports
├── test (Node.js 24)        npm ci → build → test:ci          → ci:reports → upload test reports
│
└── websrv-ci                Passes only if every job above succeeded
```

`quality`, `gitleaks`, `trivy` and the `test` matrix run independently. `websrv-ci`
waits for all of them, including both security scans.

| Job                      | Purpose                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `quality`                | ESLint, Prettier and tests of the CI tooling, run once on Node.js 22.           |
| `gitleaks`               | Validate the detector and scan complete history for secrets, outside the Node.js matrix. |
| `trivy`                  | Scan locked runtime and development dependencies, generate an SBOM and enforce the vulnerability policy. |
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

- `quality` and every `test` job install dependencies with `npm ci`. It installs exactly what
  `package-lock.json` specifies, never writes the lockfile, and fails if `package.json`
  and `package-lock.json` disagree.
- Each `test` job then runs `git diff --exit-code -- package-lock.json` to confirm the
  lockfile was not modified.
- `actions/setup-node` with `cache: npm` caches the npm download cache (`~/.npm`), using
  the hash of `package-lock.json` as the key. `node_modules` is never cached, so every run
  starts from a clean install.

The `gitleaks` and `trivy` jobs each download a checksum-verified standalone CLI and use
Node.js built-in modules for their tooling and tests. Neither installs npm dependencies
or executes application lifecycle scripts. Trivy inventories the repository's lockfile
directly, including development dependencies with `--include-dev-deps`.

## Quality checks

| Check          | Command                 | Scope                                                                             |
| -------------- | ----------------------- | --------------------------------------------------------------------------------- |
| ESLint         | `npm run lint:check`    | `{src,app,lib,tests,config,test}/**/*.ts`                                         |
| Prettier       | `npm run format:check`  | `{src,app,lib,tests,config,test,scripts}/**/*.{ts,cjs,json,yml,yaml}` (`--check`) |
| CI tooling     | `npm run test:ci-tools` | `scripts/*.test.cjs`, including report, secret scan and Trivy evidence tests, run with `node --test` |

These checks only report problems. They never change files.

ESLint only covers TypeScript: its type-aware rules need every file to be part of the
`tsconfig.json` project, which does not include JavaScript. The CI scripts in `scripts/`
are only checked by Prettier and by their own tests. Other files under `config/`,
such as the systemd unit and SELinux policy in `config/sys/`, are not supported by either
tool and are not checked. Prettier also skips anything listed in `.gitignore`, such as the
TLS certificates in `config/tls/`.

The native Trivy policy regression needs the pinned scanner binary. It runs in the
`trivy` job and is skipped by `test:ci-tools` when `TRIVY_BINARY` is unset. It checks
severity filtering, blocking findings without a fix and malformed scanner input.

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
| `npm run test:ci-tools`       | Tests of CI report generation, secret scan policy and Trivy evidence validation. |
| `jest-junit` in `package.json` | JUnit output path and format. Suites that fail to run are reported as errors.     |

`npm test` and `npm run test:cov` are unchanged and write no JUnit, JSON results or
baseline. All these commands share the Jest configuration in `package.json`, including
the coverage scope (`collectCoverageFrom`). The CI scripts only add reporters on the
command line; `test:coverage:ci` selects the `json`, `json-summary`, `lcov` and `text`
coverage reporters. `jest-junit` is pinned to an exact version in `package.json`.

The shared Jest configuration discovers unit tests under `src/` and integration tests
under `test/`. Every matrix job runs both in the same Jest invocation, so the existing
JUnit, JSON results and reference coverage include the integration tests. Coverage
continues to measure application sources under `src/`, excluding the test harness.
`npm run test:e2e` uses `test/jest-e2e.json` to run just the integration tests locally.

Integration tests use ephemeral loopback ports and temporary frontend, documentation
and TLS files; they require no running FWCloud API or external network access. The
`openssl` executable generates temporary self-signed certificates and is available on
the workflow's Ubuntu runners. Install it locally before running the suite. Teardown
closes servers and connections, removes temporary files and restores intercepted PID
writes and process exits.

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
compare runs. Read the current measurements from the reference run's `baseline.json`;
the integration tests exercise proxying, static files and HTTP/HTTPS startup in
`websrv.service.ts`.

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

## Secret detection

### Reference and scope

The `gitleaks` job reuses the standalone CLI installation and default-rule configuration
from [FWCloud API's Gitleaks implementation](https://github.com/soltecsis/fwcloud-api/blob/78dd33452521b595f6f7c9a890209ef62a1af27f/.github/workflows/nodejs.yml),
introduced by PR #1563 and available on `ENS`. This is the reference missing from the
previously inspected API `main` and `devel` branches. The ignore-file and inline-suppression
policy follows [FWCloud UI's implementation](https://github.com/soltecsis/fwcloud-ui-src/blob/14fabe077d5064d32d14017c40b2dca38acaa162/.github/workflows/main.yml),
introduced by PR #1638 and available on `ENS`.

The pinned version is **Gitleaks 8.30.1**. Its official Linux x64 archive has SHA-256
`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`.
The shared installation values are recorded in
[`scripts/gitleaks-config.json`](../scripts/gitleaks-config.json); the archive checksum
and CLI version are checked before scanning. [`.gitleaks.toml`](../.gitleaks.toml)
extends the bundled default rules without exclusions, a baseline or custom allowlists.

Unlike the incremental PR/push ranges used by API and UI, Websrv scans all available
history on **every configured push and pull request**. No scheduled scan is added.
Checkout uses `fetch-depth: 0` and `persist-credentials: false`. The wrapper rejects
shallow repositories and uses
`--log-opts='--all HEAD --diff-merges=first-parent'`: branches, remote-tracking refs
and tags available in the checkout are included, together with detached `HEAD` (such as
GitHub's PR merge commit). Merge commits include their diff against the first parent,
so a secret introduced during a merge is inspected. This diff option does not restrict
history traversal to first-parent ancestry: commits on other parents remain in scope.
The scan covers secrets removed from the current working tree and commits outside the
current branch. It cannot cover deleted/unfetched refs or unreachable objects held only
on the server.

### Policy and failure handling

[`scripts/scan-secrets.cjs`](../scripts/scan-secrets.cjs) rejects any `.gitleaksignore`
entry in the current repository working tree, including nested files, ignored paths
and symlinks. Git metadata under `.git` is excluded from this filesystem check. Remove
the prohibited file; do not add fingerprints to suppress findings.

The scanner receives an empty temporary ignore file and `--ignore-gitleaks-allow`, so
inline allow comments do not suppress findings. It uses complete redaction
(`--redact=100`), a 300-second timeout and exit code `5` for findings. Child-process
output is withheld from logs because scanner errors can include content or paths.
Only code `0` with a valid empty JSON array counts as success. Findings, any other
exit code, missing/malformed reports, inconsistent results and incomplete execution
fail the job. Download, integrity and detector regression failures also block CI.
`websrv-ci` requires the `gitleaks` job to finish with `success`; failure, cancellation
or omission cannot satisfy the aggregate check.

The native JSON report and empty ignore file exist only in a private temporary
directory and are removed after use. The only retained report is
`reports/secrets/metadata.json`, in the artifact
`websrv-secrets-<RUN_ID>-<ATTEMPT>` with 14-day requested retention. It records scan
status and affected commit/file/rule/line locations, using an explicit field allowlist.
It excludes secret values, matched source, authors, commit messages and arbitrary
scanner error text. The job summary and console output contain aggregate status only.
Use the artifact's locations to investigate findings without copying credential values
into issues, comments or shared logs.

### Local execution

Use Node.js 22, Git and the same pinned Gitleaks version. The commands below install
the official Linux x64 binary into a temporary directory without npm dependencies:

```bash
GITLEAKS_VERSION=$(node -p 'require("./scripts/gitleaks-config.json").version')
GITLEAKS_ARCHIVE=$(node -p 'require("./scripts/gitleaks-config.json").archive')
GITLEAKS_SHA256=$(node -p 'require("./scripts/gitleaks-config.json").archiveSha256')
GITLEAKS_INSTALL_DIR=$(mktemp -d)
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ARCHIVE}" \
  --output "$GITLEAKS_INSTALL_DIR/$GITLEAKS_ARCHIVE"
printf '%s  %s\n' "$GITLEAKS_SHA256" "$GITLEAKS_INSTALL_DIR/$GITLEAKS_ARCHIVE" \
  | sha256sum --check --strict
tar -xzf "$GITLEAKS_INSTALL_DIR/$GITLEAKS_ARCHIVE" -C "$GITLEAKS_INSTALL_DIR" gitleaks
test "$("$GITLEAKS_INSTALL_DIR/gitleaks" version)" = "$GITLEAKS_VERSION"
```

Run each command only after the preceding command succeeds. For another platform,
obtain the same release for that platform and verify its published checksum before use.

Fetch complete history from the repository's `origin`, including its branches and tags:

```bash
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --unshallow origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
else
  git fetch origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
fi
GITLEAKS_BINARY="$GITLEAKS_INSTALL_DIR/gitleaks" node scripts/scan-secrets.cjs
```

`GITLEAKS_BINARY` is optional when the pinned `gitleaks` is already on `PATH`. The
wrapper scans every locally available ref; it does not fetch other configured remotes.
Review local refs if the clone includes additional remotes. Local uncommitted content
is not scanned by Git mode, apart from the `.gitleaksignore` policy check.

The dedicated CI job verifies the real detector before scanning the repository:

```bash
GITLEAKS_BINARY="$GITLEAKS_INSTALL_DIR/gitleaks" \
  node --test scripts/scan-secrets.integration.cjs
npm run test:ci-tools
```

The integration regression uses an isolated temporary Git repository and a synthetic
detectable credential. It checks detection after the credential has been removed from
the latest working tree, including history outside the checked-out branch. No functional
credential is required and the fixture is not committed to this repository's history.
The unit tests cover wrapper policy, error handling and safe output. These commands
provide a repeatable verification procedure; an actual repository scan must still pass.

### Initial local validation

An isolated scan equivalent to Websrv's `origin` checkout at
`d97081fca53c9668919d8a004e0e5aa0be4091a8` covered 214 reachable commits, 46 `origin`
refs and 22 tags. It completed with zero findings. This records a local result for that
scope, not a successful GitHub Actions execution or a guarantee about future commits.

The developer clone also contains a `soltecsis-jfernandez` remote for `fwcloud-ui-src`.
Scanning all of that clone's refs correctly reports 25 `generic-api-key` findings from
UI history: `src/app/classes/fwc-crypto.ts:8` in commit
`14fb5e5114287292d2ce7522d3a716018e2f96e5` and historical `dist/main.*` JavaScript bundles.
These findings require separate review by the UI resource owner; no Websrv suppression
was added. The local scan wrote the complete safe location inventory to the ignored
`reports/secrets/metadata.json`. For a CI-equivalent local audit, use an isolated Websrv
clone: fetching `origin` does not remove previously fetched refs from other remotes.

### Handling findings

Treat every finding as pending review until the resource owner classifies it. Record
only the affected commit, file, rule and resource identity in the remediation record;
never include the credential value. Confirm whether the credential was functional,
whether it remains valid, and who owns the affected service. Coordinate revocation or
rotation through the owner's established process, and remove active credentials from
current code in favor of the appropriate runtime secret configuration.

Deleting a value in the latest commit does not remove its historical exposure. Review
false positives individually with supporting evidence; do not create a `.gitleaksignore`,
baseline, inline suppression or automatic allowlist to obtain a green scan. Historical
findings continue to fail the full-history check until their treatment is agreed and
implemented. Credential rotation and Git history rewriting are not automated by this
change. Rerun the same full-history scan after remediation and retain its result before
considering the scan successful.

## Dependency vulnerabilities and SBOM

### Reference and scope

The `trivy` job follows [FWCloud API's SCA implementation](https://github.com/soltecsis/fwcloud-api/blob/d4627b256905853bd04eaa0432ba8466dae83545/.github/workflows/nodejs.yml)
and [shared scanner configuration](https://github.com/soltecsis/fwcloud-api/blob/d4627b256905853bd04eaa0432ba8466dae83545/scripts/trivy-config.json)
on `ENS`: a complete JSON vulnerability report, an independently generated CycloneDX
SBOM, a native severity gate and diagnostic evidence. [FWCloud UI's `upstream/ENS`
reference](https://github.com/soltecsis/fwcloud-ui-src/blob/e08b70e817425acb9e0ce009cb396dad32fbadbb/.github/workflows/main.yml)
uses the same JSON/CycloneDX filenames, severity policy, run/attempt naming and 90-day
retention. Its scanner is newer (`0.76.1`) and it converts the vulnerability JSON to an
SBOM; Websrv follows API's `0.74.0` pin and independent SBOM generation. Neither
reference requires a SARIF artifact.

[`scripts/trivy-config.json`](../scripts/trivy-config.json) records Trivy **0.74.0**,
the Linux x64 archive `trivy_0.74.0_Linux-64bit.tar.gz` and its SHA-256:
`2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a`.
CI verifies the checksum and executed version before scanning. The database is updated
by Trivy; a pinned binary does not freeze vulnerability data or future findings.

The filesystem scanner runs on the repository (`trivy fs .`) with `--scanners vuln`
and `--pkg-types library`. It inventories direct and transitive runtime, development
and optional npm dependencies represented in `package.json` and `package-lock.json`.
`--include-dev-deps` explicitly includes development dependencies; `--list-all-pkgs`
retains the complete inventory. It does not need `node_modules`, a build, a database
service or a successful Node.js test matrix. The job uses the same default checkout as
the other Websrv jobs: on pull requests this is GitHub's test merge commit. Evidence
records the checked-out revision and lockfile checksum.

This scan covers the repository dependency inventory. The resulting SBOM is
CycloneDX **1.7**, generated separately without vulnerability entries. It does not
describe a built container or prove which dependencies a deployed installation uses.

### Policy and failure handling

| Condition | Result |
| --------- | ------ |
| `HIGH` or `CRITICAL`, with or without a fixed version | Fail CI. |
| `UNKNOWN`, `LOW` or `MEDIUM` only | Report without blocking. |
| Installation, checksum, database, scanner or SBOM error | Fail CI. |
| Missing, malformed, empty or inconsistent required evidence | Fail CI. |
| Root lockfile not inventoried or npm inventory empty | Fail CI. |

The initial scan writes all severities to `trivy.json` with `--exit-code 0` and
`--ignore-unfixed=false`. This keeps informational findings available; it does not
accept scanner execution errors. A subsequent `trivy convert` command applies
`--severity HIGH,CRITICAL --exit-code 5` to that JSON without repeating the scan.
Code `0` accepts the severity gate, `5` means blocking findings, and any other nonzero
code is an operational error. Both findings and errors fail the job. Pipeline exit
codes are captured before `tee` can hide scanner or report-writing failures.

`TRIVY_CONFIG=/dev/null` and `TRIVY_IGNOREFILE=/dev/null` prevent implicit repository
configuration or ignore files from suppressing findings. An absent fix does not create
an exception. This integration adds no automatic upgrades or vulnerability exclusions.

[`scripts/trivy-report.cjs`](../scripts/trivy-report.cjs) validates scanner exit codes,
the pinned version and database timestamp, the root npm inventory, SBOM components and
dependency references, and agreement between the native gate and reported findings.
It writes aggregate metadata and a job summary. Invalid evidence fails validation;
an omitted scan never becomes a clean result.

### Reports and artifacts

The security job publishes `websrv-sca-sbom-<RUN_ID>-<ATTEMPT>` with **90-day requested
retention** and `if-no-files-found: error`. Its files are generated under:

```text
reports/dependencies/
├── metadata.json          Revision, run, database, package counts, severities and validation errors
├── sbom.cdx.json          CycloneDX 1.7 inventory and dependency relationships
├── trivy.json             Complete machine-readable vulnerability report and package inventory
├── trivy-version.json     Executed scanner and vulnerability database versions
├── blocking.txt           Native HIGH/CRITICAL gate table or diagnostic output
├── context.txt            Run, checkout, step outcomes and native exit codes
├── scan.log               Vulnerability scanner diagnostics
└── sbom.log               SBOM generation diagnostics
```

Download the artifact from the workflow run's **Artifacts** section. It includes CVE
identifiers, installed versions and available fixes in `trivy.json`; `blocking.txt`
shows the findings that block CI. Paths above describe generation in the checkout;
the upload places these files at the artifact root.

The policy/context step and artifact upload use `always()`, so a vulnerability failure
still leaves the report and SBOM available. Operational failures preserve whatever
evidence was produced, including diagnostics and error context. A failed installation
or scan can leave a partial artifact; missing files are not fabricated and do not make
the job succeed. `websrv-ci` requires `trivy` to finish with `success`.

### Local dependency scan

Use Node.js 22 for the configuration reads and tooling, and run the commands from the
repository root. No npm installation is needed. These commands install the same
verified Linux x64 release into a temporary directory:

```bash
TRIVY_VERSION=$(node -p 'require("./scripts/trivy-config.json").version')
TRIVY_ARCHIVE=$(node -p 'require("./scripts/trivy-config.json").archive')
TRIVY_SHA256=$(node -p 'require("./scripts/trivy-config.json").archiveSha256')
TRIVY_INSTALL_DIR=$(mktemp -d)
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${TRIVY_ARCHIVE}" \
  --output "$TRIVY_INSTALL_DIR/$TRIVY_ARCHIVE"
printf '%s  %s\n' "$TRIVY_SHA256" "$TRIVY_INSTALL_DIR/$TRIVY_ARCHIVE" \
  | sha256sum --check --strict
tar -xzf "$TRIVY_INSTALL_DIR/$TRIVY_ARCHIVE" -C "$TRIVY_INSTALL_DIR" trivy
TRIVY_VERSION_OUTPUT=$("$TRIVY_INSTALL_DIR/trivy" --version)
test "${TRIVY_VERSION_OUTPUT%%$'\n'*}" = "Version: $TRIVY_VERSION"
```

Run each command only after the preceding command succeeds. On another platform, use
the same release for that platform and verify its published checksum. Database
downloads require network access. Use the same checkout and lockfile as CI when
comparing results; later database updates can change the findings.

Run the official CLI directly in Bash, preserving scanner failures through pipelines:

```bash
export TRIVY_CONFIG=/dev/null
export TRIVY_IGNOREFILE=/dev/null
export TRIVY_TIMEOUT=10m
export TRIVY_DISABLE_TELEMETRY=true
export TRIVY_SKIP_VERSION_CHECK=true
export TRIVY_CACHE_DIR="$TRIVY_INSTALL_DIR/cache"
set -o pipefail
mkdir -p reports/dependencies

"$TRIVY_INSTALL_DIR/trivy" fs . --scanners vuln --pkg-types library \
  --include-dev-deps --list-all-pkgs --no-progress \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --ignore-unfixed=false \
  --exit-code 0 --format json --output reports/dependencies/trivy.json \
  2>&1 | tee reports/dependencies/scan.log

"$TRIVY_INSTALL_DIR/trivy" fs . --include-dev-deps --no-progress \
  --format cyclonedx --output reports/dependencies/sbom.cdx.json \
  2>&1 | tee reports/dependencies/sbom.log

"$TRIVY_INSTALL_DIR/trivy" version --format json \
  > reports/dependencies/trivy-version.json

"$TRIVY_INSTALL_DIR/trivy" convert --format table --scanners vuln \
  --severity HIGH,CRITICAL --exit-code 5 reports/dependencies/trivy.json \
  2>&1 | tee reports/dependencies/blocking.txt
```

The last command returns `5` for blocking findings, including those without a fix.
Stop and investigate other nonzero results before interpreting the reports. CI also
generates `metadata.json` and `context.txt` and performs the evidence validation
described above. For a table of every severity, run:

```bash
"$TRIVY_INSTALL_DIR/trivy" convert --format table --scanners vuln \
  reports/dependencies/trivy.json

TRIVY_BINARY="$TRIVY_INSTALL_DIR/trivy" node --test scripts/trivy-policy.test.cjs
node --test scripts/trivy-report.test.cjs
```

### Remediating vulnerabilities

Review `blocking.txt` and the corresponding `trivy.json` entry for each CVE, affected
package, installed version and `FixedVersion`. Use `npm explain <package>` in an installed
development checkout to identify which direct dependency brings in a vulnerable
transitive dependency.

When a fix exists, deliberately update the affected direct dependency or its parent
to a compatible fixed release and commit both manifest and lockfile changes as needed.
For a finding without a fix, investigate removing or replacing the dependency or an
upstream release that removes the vulnerable code. Record the affected dependency,
advisory and remediation owner; the finding continues to block until resolved. Adding
ignore files, filtering unfixed findings or lowering severity does not satisfy this
policy.

After remediation, run the same scan and gate, then the build and test checks documented
below. Check informational findings as part of maintenance even though `LOW` and
`MEDIUM` do not block. This CI integration does not upgrade dependencies automatically.

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
individual `quality`, `gitleaks`, `trivy` or `test (Node.js <x>)` checks: matrix check names change when the matrix
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
| `gitleaks` reports findings | Download its safe metadata artifact and follow [Handling findings](#handling-findings). A secret deleted from the latest tree is still detected in history. |
| `gitleaks` rejects `.gitleaksignore` | Remove the prohibited entry, including nested files or symlinks. Findings must be reviewed without ignore fingerprints. |
| `gitleaks` reports an execution error | Check the pinned binary/checksum, full Git checkout and local reproduction. Missing or inconsistent results fail CI; they are not a clean scan. |
| `trivy` reports HIGH/CRITICAL findings (gate code `5`) | Download `websrv-sca-sbom-...`, review `blocking.txt` and `trivy.json`, then follow [Remediating vulnerabilities](#remediating-vulnerabilities). Findings without a fix also block. |
| `trivy` fails to install, scan or generate an SBOM | Inspect `context.txt`, `scan.log` and `sbom.log` when available. Check the pinned version/checksum and database network access. Operational errors fail CI; rerun after resolving the cause. |
| Trivy evidence validation fails or the artifact is partial | Inspect `metadata.json` and step outcomes in `context.txt`. Missing/invalid reports, an empty npm inventory, differing SBOM packages or a missing database timestamp cannot satisfy the check. Reproduce using [Local dependency scan](#local-dependency-scan). |
| The coverage artifact has no `baseline.json` | The Node.js 22 run failed or its coverage was invalid, so no baseline was recorded. See that job's summary. |
| `sha256sum -c reports/coverage/lcov.sha256` fails | `coverage/lcov.info` is not the file the baseline was recorded for. Download the artifact again, unmodified. |
| `websrv-ci` fails but no job failed | A required job was cancelled or skipped. Check the job list in the run summary, then re-run the workflow. A cancelled run on an old commit can be ignored if a newer run exists. |
| `websrv-ci` stays at "Expected — Waiting for status to be reported" | The workflow did not run for that commit. Usually the PR targets a branch that is not listed in [Triggers](#triggers). |
| `websrv-ci` does not appear when configuring branch protection | The check has not run in the last 7 days. Open or update a pull request against one of the trigger branches first. |
