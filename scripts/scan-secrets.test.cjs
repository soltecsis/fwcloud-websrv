const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { scan, projectFindings } = require('./scan-secrets.cjs');
const config = require('./gitleaks-config.json');

const finding = {
  RuleID: 'github-pat',
  Commit: 'a'.repeat(40),
  File: 'credentials.env',
  StartLine: 2,
  EndLine: 2,
  Secret: 'PRIVATE_FIXTURE_VALUE',
  Match: 'PRIVATE_FIXTURE_VALUE',
  Message: 'PRIVATE_FIXTURE_VALUE',
  Author: 'PRIVATE_FIXTURE_VALUE',
  Email: 'PRIVATE_FIXTURE_VALUE',
};

function fixture(
  t,
  {
    code = 0,
    report = [],
    raw,
    missing = false,
    version = config.version,
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'websrv-scan-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '--template=');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=ci@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    `core.hooksPath=${os.devNull}`,
    'commit',
    '--allow-empty',
    '-m',
    'Clean fixture',
  );
  const binary = path.join(directory, 'gitleaks');
  const record = path.join(directory, 'report-path.txt');
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `if (process.argv[2] === 'version') { console.log(${JSON.stringify(version)}); process.exit(0); }\n` +
      `const report = process.argv[process.argv.indexOf('--report-path') + 1];\n` +
      `fs.writeFileSync(${JSON.stringify(record)}, report);\n` +
      `if (!${missing}) fs.writeFileSync(report, ${JSON.stringify(raw ?? JSON.stringify(report))});\n` +
      `console.log('PRIVATE_FIXTURE_VALUE'); console.error('PRIVATE_FIXTURE_VALUE');\n` +
      `process.exit(${code});\n`,
    { mode: 0o700 },
  );
  return {
    repo,
    binary,
    temporaryReport: () => fs.readFileSync(record, 'utf8'),
  };
}

test('publishes only rule, commit, file and lines from each finding', () => {
  assert.deepEqual(projectFindings([finding]), [
    {
      ruleId: 'github-pat',
      commit: finding.Commit,
      file: 'credentials.env',
      startLine: 2,
      endLine: 2,
    },
  ]);
});

test('rejects malformed reports and findings', () => {
  for (const report of [
    null,
    {},
    [null],
    [{ ...finding, RuleID: undefined }],
    [{ ...finding, Commit: 'bad' }],
    [{ ...finding, File: '' }],
    [{ ...finding, StartLine: 0 }],
    [{ ...finding, EndLine: 1 }],
  ]) {
    assert.throws(() => projectFindings(report));
  }
});

for (const options of [
  { code: 1 },
  { code: 2, report: [finding] },
  { code: 0, report: [finding] },
  { code: config.findingsExitCode, report: [] },
  { code: 0, raw: '[PRIVATE_FIXTURE_VALUE' },
  { code: 0, report: { unexpected: 'PRIVATE_FIXTURE_VALUE' } },
  { code: 0, missing: true },
]) {
  test(`fails closed for exit ${options.code} with ${options.missing ? 'missing' : options.raw ? 'malformed' : 'inconsistent'} report ${JSON.stringify(options.report?.length ?? '')}`, (t) => {
    const f = fixture(t, options);
    const metadata = scan(f.repo, f.binary);
    assert.equal(metadata.status, 'error');
    assert.ok(metadata.errors.length > 0);
    assert.ok(!JSON.stringify(metadata).includes('PRIVATE_FIXTURE_VALUE'));
    assert.ok(!fs.existsSync(path.dirname(f.temporaryReport())));
  });
}

test('accepts findings with the dedicated exit code and removes the native report', (t) => {
  const f = fixture(t, { code: config.findingsExitCode, report: [finding] });
  const metadata = scan(f.repo, f.binary);
  assert.equal(metadata.status, 'findings');
  assert.equal(metadata.findingCount, 1);
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE_FIXTURE_VALUE'));
  assert.ok(!fs.existsSync(path.dirname(f.temporaryReport())));
});

test('rejects an unexpected scanner version', (t) => {
  const f = fixture(t, { version: '0.0.0' });
  const metadata = scan(f.repo, f.binary);
  assert.equal(metadata.status, 'error');
  assert.equal(metadata.exitCode, null);
});

test('unexpected filesystem errors cannot expose arbitrary paths', (t) => {
  const f = fixture(t);
  const original = fs.readdirSync;
  fs.readdirSync = () => {
    throw new Error('PRIVATE_FIXTURE_VALUE');
  };
  t.after(() => {
    fs.readdirSync = original;
  });
  const metadata = scan(f.repo, f.binary);
  assert.equal(metadata.status, 'error');
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE_FIXTURE_VALUE'));
});
