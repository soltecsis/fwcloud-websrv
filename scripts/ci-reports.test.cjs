const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.join(__dirname, 'ci-reports.cjs');
const git = (...args) =>
  execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim();
const gitDir = git('rev-parse', '--absolute-git-dir');
const head = git('rev-parse', 'HEAD');

const LCOV = 'TN:\nSF:src/example.ts\nDA:1,1\nDA:2,0\nend_of_record\n';
const PASSING_RESULTS = {
  success: true,
  numTotalTestSuites: 1,
  numFailedTestSuites: 0,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{ name: 'DO_NOT_INCLUDE_IN_SUMMARY' }],
};

function reports({ results = {}, coverage = false, lcov = LCOV } = {}) {
  const files = {
    'reports/jest/junit.xml': '<testsuites>\n</testsuites>\n',
    'reports/jest/results.json': { ...PASSING_RESULTS, ...results },
  };
  if (coverage) {
    const metric = { total: 4, covered: 1, skipped: 0, pct: 25 };
    files['coverage/lcov.info'] = lcov;
    files['coverage/coverage-final.json'] = {};
    files['coverage/coverage-summary.json'] = {
      total: {
        lines: metric,
        statements: metric,
        functions: metric,
        branches: metric,
      },
    };
  }
  return files;
}

function run(t, files, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websrv-ci-reports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(
      path.join(dir, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
      PULL_REQUEST_HEAD_SHA: '',
      TEST_OUTCOME: 'success',
      COVERAGE_EXPECTED: 'false',
      ...env,
    },
  });
  assert.equal(result.error, undefined);
  const read = (file) =>
    fs.existsSync(path.join(dir, file))
      ? fs.readFileSync(path.join(dir, file), 'utf8')
      : null;
  const summary = read('summary.md');
  assert.ok(!summary.includes('DO_NOT_INCLUDE_IN_SUMMARY'));
  return {
    status: result.status,
    stderr: result.stderr,
    metadata: JSON.parse(read('reports/metadata.json')),
    summary,
    read,
  };
}

test('accepts complete test reports on runs without coverage', (t) => {
  const { status, stderr, metadata, read } = run(t, reports());
  assert.equal(status, 0, stderr);
  assert.equal(metadata.commit, head);
  assert.equal(metadata.node, process.version);
  assert.equal(metadata.tests.numPassedTests, 2);
  assert.equal(metadata.coverage, null);
  assert.equal(read('reports/coverage/baseline.json'), null);
});

test('fails without the reports and still writes metadata', (t) => {
  const { status, metadata } = run(t, {});
  assert.equal(status, 1);
  assert.equal(metadata.tests, null);
  assert.ok(
    metadata.errors.includes('Missing or empty report: reports/jest/junit.xml'),
  );
});

test('names the report that is not valid JSON', (t) => {
  const files = { ...reports(), 'reports/jest/results.json': '{"trunc' };
  const { status, metadata } = run(t, files);
  assert.equal(status, 1);
  assert.ok(
    metadata.errors.includes('Invalid JSON report: reports/jest/results.json'),
  );
});

test('preserves a failed test step even if the reports look successful', (t) => {
  const { status, metadata } = run(t, reports(), { TEST_OUTCOME: 'failure' });
  assert.equal(status, 1);
  assert.ok(metadata.errors.includes('Test step outcome: failure'));
});

test('fails on a suite that could not run although no test failed', (t) => {
  const results = { success: false, numFailedTestSuites: 1 };
  assert.equal(run(t, reports({ results })).status, 1);
});

test('fails when no tests were executed', (t) => {
  const results = { numTotalTests: 0, numPassedTests: 0 };
  assert.equal(run(t, reports({ results })).status, 1);
});

test('fails on the reference run without coverage and records no baseline', (t) => {
  const { status, read } = run(t, reports(), { COVERAGE_EXPECTED: 'true' });
  assert.equal(status, 1);
  assert.equal(read('reports/coverage/baseline.json'), null);
});

test('rejects an incomplete LCOV file', (t) => {
  const files = reports({ coverage: true, lcov: 'SF:src/example.ts\n' });
  const { status, metadata } = run(t, files, { COVERAGE_EXPECTED: 'true' });
  assert.equal(status, 1);
  assert.ok(
    metadata.errors.includes('Invalid LCOV report: coverage/lcov.info'),
  );
});

test('removes a stale baseline when the new reference run fails', (t) => {
  const files = {
    ...reports({ coverage: true }),
    'reports/coverage/baseline.json': {},
    'reports/coverage/lcov.sha256': 'stale',
  };
  const { status, read } = run(t, files, {
    COVERAGE_EXPECTED: 'true',
    TEST_OUTCOME: 'failure',
  });
  assert.equal(status, 1);
  assert.equal(read('reports/coverage/baseline.json'), null);
  assert.equal(read('reports/coverage/lcov.sha256'), null);
});

test('records a baseline bound to the LCOV file without thresholds', (t) => {
  const { status, stderr, summary, read } = run(
    t,
    reports({ coverage: true }),
    {
      COVERAGE_EXPECTED: 'true',
      PULL_REQUEST_HEAD_SHA: 'abc123',
    },
  );
  assert.equal(status, 0, stderr);
  const sha256 = crypto.createHash('sha256').update(LCOV).digest('hex');
  const baseline = JSON.parse(read('reports/coverage/baseline.json'));
  assert.equal(baseline.commit, head);
  assert.equal(baseline.pullRequestHeadCommit, 'abc123');
  assert.equal(baseline.node, process.version);
  assert.ok(Date.parse(baseline.generatedAt));
  assert.deepEqual(baseline.lcov, { path: 'coverage/lcov.info', sha256 });
  for (const key of ['lines', 'statements', 'functions', 'branches']) {
    assert.equal(baseline.coverage[key].pct, 25);
  }
  assert.equal(
    read('reports/coverage/lcov.sha256'),
    `${sha256}  coverage/lcov.info\n`,
  );
  assert.ok(summary.includes('| lines | 25 | 1 / 4 |'));
  assert.ok(summary.includes(sha256));
});
