// Validates the Jest and coverage reports of one CI test run and records their
// metadata. On the reference run it also records the coverage baseline, bound
// to the exact LCOV file by its SHA-256. Adapted from fwcloud-api.
// The summary shows aggregates only: test names, failure messages and source
// code stay in the uploaded artifacts.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const JUNIT = 'reports/jest/junit.xml';
const JEST_RESULTS = 'reports/jest/results.json';
const METADATA = 'reports/metadata.json';
const LCOV = 'coverage/lcov.info';
const COVERAGE_FINAL = 'coverage/coverage-final.json';
const COVERAGE_SUMMARY = 'coverage/coverage-summary.json';
const BASELINE_DIR = 'reports/coverage';
// Same order as the summary table columns.
const TEST_COUNTERS = [
  'numTotalTestSuites',
  'numFailedTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
];
const COVERAGE_METRICS = ['lines', 'statements', 'functions', 'branches'];

const env = process.env;
const coverageExpected = env.COVERAGE_EXPECTED === 'true';
const testOutcome = env.TEST_OUTCOME || 'unknown';
const errors = [];
const metadata = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: env.GITHUB_REPOSITORY || null,
  // The checked-out revision. On pull requests, GitHub's test merge commit.
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  pullRequestHeadCommit: env.PULL_REQUEST_HEAD_SHA || null,
  event: env.GITHUB_EVENT_NAME || null,
  ref: env.GITHUB_REF || null,
  runId: env.GITHUB_RUN_ID || null,
  runAttempt: env.GITHUB_RUN_ATTEMPT || null,
  node: process.version,
  npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
  testOutcome,
  coverageExpected,
  tests: null,
  coverage: null,
  errors,
};

function readReport(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`Missing or empty report: ${file}`);
  }
  return fs.readFileSync(file);
}

function readJsonReport(file) {
  const content = readReport(file);
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON report: ${file}`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const toJson = (data) => `${JSON.stringify(data, null, 2)}\n`;

// A baseline left by an earlier local run must never describe these reports.
fs.rmSync(BASELINE_DIR, { recursive: true, force: true });

try {
  if (!readReport(JUNIT).toString('utf8').includes('</testsuites>')) {
    throw new Error(`Invalid JUnit report: ${JUNIT}`);
  }
  const results = readJsonReport(JEST_RESULTS);
  for (const key of TEST_COUNTERS) {
    if (!Number.isSafeInteger(results[key]) || results[key] < 0) {
      throw new Error(`Invalid test counter: ${key}`);
    }
  }
  metadata.tests = Object.fromEntries(
    TEST_COUNTERS.map((key) => [key, results[key]]),
  );
  if (results.numTotalTests === 0) errors.push('No tests executed.');
  // A suite that fails to compile adds a failed suite but no failed test.
  if (
    results.success !== true ||
    results.numFailedTests > 0 ||
    results.numFailedTestSuites > 0
  ) {
    errors.push('Test failures reported.');
  }
} catch (error) {
  errors.push(error.message);
}

let lcov = null;
if (coverageExpected) {
  try {
    lcov = readReport(LCOV);
    const text = lcov.toString('utf8');
    const sourceFiles = text.match(/^SF:.+$/gm)?.length ?? 0;
    const records = text.match(/^end_of_record$/gm)?.length ?? 0;
    if (sourceFiles === 0 || sourceFiles !== records) {
      throw new Error(`Invalid LCOV report: ${LCOV}`);
    }
    readJsonReport(COVERAGE_FINAL);
    const { total } = readJsonReport(COVERAGE_SUMMARY);
    for (const key of COVERAGE_METRICS) {
      const pct = total?.[key]?.pct;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new Error(`Invalid coverage metric: ${key}`);
      }
    }
    if (!(total.lines.total > 0)) {
      throw new Error('Coverage contains no source lines.');
    }
    metadata.coverage = Object.fromEntries(
      COVERAGE_METRICS.map((key) => [key, total[key]]),
    );
  } catch (error) {
    errors.push(error.message);
  }
}

if (testOutcome !== 'success') errors.push(`Test step outcome: ${testOutcome}`);
writeFile(METADATA, toJson(metadata));

// Only a complete, passing reference run becomes a coverage baseline. The
// checksum is computed from the same bytes validated above.
let lcovSha256 = null;
if (coverageExpected && errors.length === 0) {
  lcovSha256 = crypto.createHash('sha256').update(lcov).digest('hex');
  writeFile(
    `${BASELINE_DIR}/baseline.json`,
    toJson({ ...metadata, lcov: { path: LCOV, sha256: lcovSha256 } }),
  );
  writeFile(`${BASELINE_DIR}/lcov.sha256`, `${lcovSha256}  ${LCOV}\n`);
}

const summary = [
  `## Websrv test reports (Node.js ${metadata.node})`,
  '',
  `Commit: \`${metadata.commit}\``,
];
if (metadata.pullRequestHeadCommit) {
  summary.push('', `Pull request head: \`${metadata.pullRequestHeadCommit}\``);
}
summary.push(
  '',
  `Reports: **${errors.length ? 'FAILED / INCOMPLETE' : 'COMPLETE'}**`,
);
if (metadata.tests) {
  summary.push(
    '',
    '| Suites | Failed suites | Tests | Passed | Failed | Skipped | Todo |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${TEST_COUNTERS.map((key) => metadata.tests[key]).join(' | ')} |`,
  );
}
if (metadata.coverage) {
  summary.push('', '| Coverage | % | Covered / total |', '| --- | --- | --- |');
  for (const key of COVERAGE_METRICS) {
    const { pct, covered, total } = metadata.coverage[key];
    summary.push(`| ${key} | ${pct} | ${covered} / ${total} |`);
  }
}
if (lcovSha256) summary.push('', `LCOV SHA-256: \`${lcovSha256}\``);
if (errors.length) {
  summary.push('', ...errors.map((error) => `- ${error}`));
}

const text = `${summary.join('\n')}\n`;
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
console.log(text.trimEnd());
if (errors.length) process.exitCode = 1;
