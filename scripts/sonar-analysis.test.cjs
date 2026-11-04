const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const yaml = require('js-yaml');
const {
  verifyCoverage,
  prepare,
  recordEvidence,
  runScanner,
} = require('./sonar-analysis.cjs');

const script = path.join(__dirname, 'sonar-analysis.cjs');
const lcov = Buffer.from('TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
const digest = (data) => createHash('sha256').update(data).digest('hex');
const reference = {
  repository: 'soltecsis/fwcloud-websrv',
  commit: 'a'.repeat(40),
  event: 'push',
  ref: 'refs/heads/ENS',
  pullRequestHeadCommit: null,
  runId: '10',
  runAttempt: '2',
};

function evidence(run = reference, data = lcov) {
  const metric = { total: 2, covered: 1, skipped: 0, pct: 50 };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...run,
    node: 'v22.20.0',
    npm: '10.9.3',
    testOutcome: 'success',
    coverageExpected: true,
    tests: {
      numTotalTestSuites: 1,
      numFailedTestSuites: 0,
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    },
    coverage: Object.fromEntries(
      ['lines', 'statements', 'functions', 'branches'].map((key) => [
        key,
        { ...metric },
      ]),
    ),
    errors: [],
    lcov: { path: 'coverage/lcov.info', sha256: digest(data) },
  };
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'websrv-sonar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(directory, file, value) {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    Buffer.isBuffer(value) || typeof value === 'string'
      ? value
      : JSON.stringify(value),
  );
}

function nativeTask(source, projectKey) {
  write(
    source,
    '.scannerwork/report-task.txt',
    `serverUrl=https://sonarcloud.io\nprojectKey=${projectKey}\nceTaskId=fixture-task\n`,
  );
}

function fakeScanner(source) {
  const scanner = path.join(source, 'fake-scanner.cjs');
  fs.writeFileSync(
    scanner,
    `#!${process.execPath}\n` +
      "const fs = require('node:fs');\n" +
      "fs.writeFileSync('scanner-capture.json', JSON.stringify({ args: process.argv.slice(2), tokenPresent: process.env.SONAR_TOKEN === 'canary-canary-canary-canary' }));\n" +
      'if (!process.env.FAKE_SCANNER_SKIP_TASK) {\n' +
      "  const key = fs.readFileSync('sonar-project.properties', 'utf8').match(/^sonar\\.projectKey=(.+)$/m)[1].trim();\n" +
      "  fs.mkdirSync('.scannerwork', { recursive: true });\n" +
      "  fs.writeFileSync('.scannerwork/report-task.txt', 'serverUrl=https://sonarcloud.io\\nprojectKey=' + key + '\\nceTaskId=fixture-task\\n');\n" +
      '}\n' +
      "process.exit(Number(process.env.FAKE_SCANNER_EXIT || '0'));\n",
    { mode: 0o700 },
  );
  return scanner;
}

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('GITHUB_') &&
        !key.startsWith('GIT_') &&
        !key.startsWith('SONAR_') &&
        !['ANALYSIS_COMMIT', 'PR_NUMBER', 'PULL_REQUEST_HEAD_SHA'].includes(
          key,
        ),
    ),
  );
}

function checkout(t, event = 'push') {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  const coverage = path.join(directory, 'coverage-input');
  write(source, 'src/a.ts', 'export const a = 1;\n');
  write(source, 'config/a.ts', 'export const port = 3000;\n');
  write(source, 'test/a.spec.ts', 'export {};\n');
  fs.copyFileSync(
    path.join(__dirname, '../sonar-project.properties'),
    path.join(source, 'sonar-project.properties'),
  );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      env: cleanEnvironment(),
      encoding: 'utf8',
    }).trim();
  // A fixed name keeps local-mode tests independent of init.defaultBranch.
  git('init', '--quiet', '--initial-branch=feature/local');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const commit = git('rev-parse', 'HEAD');
  const isPr = event === 'pull_request';
  const run = {
    ...reference,
    commit,
    event,
    ref: isPr ? 'refs/pull/7/merge' : reference.ref,
    pullRequestHeadCommit: isPr ? commit : null,
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: run.repository,
    GITHUB_RUN_ID: run.runId,
    GITHUB_RUN_ATTEMPT: run.runAttempt,
    GITHUB_EVENT_NAME: event,
    GITHUB_SHA: isPr ? 'b'.repeat(40) : commit,
    GITHUB_REF: run.ref,
    GITHUB_REF_NAME: isPr ? '7/merge' : 'ENS',
    ANALYSIS_COMMIT: commit,
    ...(isPr
      ? {
          PR_NUMBER: '7',
          GITHUB_HEAD_REF: 'feature/sonar',
          GITHUB_BASE_REF: 'ENS',
          PULL_REQUEST_HEAD_SHA: commit,
        }
      : {}),
  };
  const metadata = evidence(run);
  write(coverage, 'coverage/lcov.info', lcov);
  write(coverage, 'reports/coverage/baseline.json', metadata);
  return { directory, source, coverage, env, metadata, commit };
}

function localCheckout(t) {
  const fixture = checkout(t);
  const metadata = evidence({
    repository: null,
    commit: fixture.commit,
    event: null,
    ref: null,
    pullRequestHeadCommit: null,
    runId: null,
    runAttempt: null,
  });
  write(fixture.source, 'coverage/lcov.info', lcov);
  write(fixture.source, 'reports/coverage/baseline.json', metadata);
  return { ...fixture, metadata };
}

for (const event of ['push', 'pull_request']) {
  test(`imports the Node.js 22 artifact from the tested revision for ${event}`, (t) => {
    const { source, coverage, env, commit } = checkout(t, event);
    const { metadata, args } = prepare(source, coverage, env);
    assert.equal(metadata.commit, commit);
    assert.equal(metadata.coverageReportSha256, digest(lcov));
    assert.equal(Number(metadata.coverageRunAttempt), 2);
    assert.equal(
      fs.readFileSync(path.join(source, 'coverage/lcov.info'), 'utf8'),
      lcov.toString(),
    );
    assert.ok(args.includes(`-Dsonar.scm.revision=${commit}`));
    // Command-line values take precedence over sonar-project.properties.
    assert.ok(args.includes('-Dsonar.qualitygate.wait=true'));
    assert.ok(args.includes('-Dsonar.qualitygate.timeout=300'));
    if (event === 'pull_request') {
      assert.ok(args.includes('-Dsonar.pullrequest.key=7'));
      assert.ok(args.includes('-Dsonar.pullrequest.branch=feature/sonar'));
      assert.ok(args.includes('-Dsonar.pullrequest.base=ENS'));
      assert.ok(!args.includes('-Dsonar.branch.name='));
    } else {
      assert.ok(args.includes('-Dsonar.branch.name=ENS'));
      assert.ok(!args.includes('-Dsonar.pullrequest.'));
    }
  });
}

test('requires successful Node.js 22 tests and the exact coverage bytes', () => {
  assert.deepEqual(verifyCoverage(evidence(), lcov, reference), ['src/a.ts']);
  for (const override of [
    { repository: 'other/websrv' },
    { commit: 'b'.repeat(40) },
    { event: 'pull_request' },
    { ref: 'refs/heads/main' },
    { runId: '11' },
    { runAttempt: '3' },
    { pullRequestHeadCommit: 'b'.repeat(40) },
    { node: 'v20.20.0' },
    { node: 'v24.1.0' },
    { testOutcome: 'failure' },
    { coverageExpected: false },
    { tests: { ...evidence().tests, numTotalTests: 0 } },
    { tests: { ...evidence().tests, numFailedTests: 1 } },
    { tests: { ...evidence().tests, numFailedTestSuites: 1 } },
    { errors: ['incomplete'] },
    { lcov: { path: 'coverage/lcov.info', sha256: 'b'.repeat(64) } },
    { lcov: { path: 'dist/lcov.info', sha256: digest(lcov) } },
  ]) {
    assert.throws(
      () => verifyCoverage({ ...evidence(), ...override }, lcov, reference),
      undefined,
      JSON.stringify(override),
    );
  }
  assert.throws(() =>
    verifyCoverage(evidence(), Buffer.from('altered'), reference),
  );
  // Provenance errors name the mismatched fields, not their values.
  assert.throws(
    () =>
      verifyCoverage(
        { ...evidence(), ref: 'refs/heads/main', runId: '11' },
        lcov,
        reference,
      ),
    /execution: ref, runId\.$/,
  );
});

test('accepts an earlier producer attempt from the same execution', (t) => {
  const { source, coverage, env, metadata } = checkout(t);
  metadata.runAttempt = '1';
  write(coverage, 'reports/coverage/baseline.json', metadata);
  const result = prepare(source, coverage, env);
  assert.equal(Number(result.metadata.coverageRunAttempt), 1);
  assert.equal(Number(result.metadata.runAttempt), 2);
  nativeTask(source, result.metadata.projectKey);
  recordEvidence(result.metadata, 'success', source, {});
  const recorded = JSON.parse(
    fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
  );
  assert.equal(Number(recorded.coverageRunAttempt), 1);
  assert.equal(Number(recorded.runAttempt), 2);
});

test('rejects missing, malformed and future attempt numbers', () => {
  for (const attempt of [
    undefined,
    null,
    false,
    [],
    [1],
    {},
    '',
    '01',
    '1junk',
    0,
    -1,
    1.5,
    '1e0',
    Number.MAX_SAFE_INTEGER + 1,
    '3',
  ]) {
    assert.throws(() =>
      verifyCoverage({ ...evidence(), runAttempt: attempt }, lcov, reference),
    );
  }
});

test('rejects generated, absolute, traversing and incomplete LCOV records', () => {
  for (const text of [
    '',
    'SF:dist/src/a.js\nDA:1,1\nend_of_record\n',
    'SF:/home/runner/src/a.ts\nDA:1,1\nend_of_record\n',
    'SF:src/../../private.ts\nDA:1,1\nend_of_record\n',
    'SF:src/./a.ts\nDA:1,1\nend_of_record\n',
    'SF:src\\a.ts\nDA:1,1\nend_of_record\n',
    'SF:src/a.d.ts\nDA:1,1\nend_of_record\n',
    'SF:src/a.ts\nDA:1,1\n',
    'SF:src/a.ts\nend_of_record\n',
    'SF:src/a.ts\nSF:src/b.ts\nDA:1,1\nend_of_record\nend_of_record\n',
    'SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/b.ts\nend_of_record\n',
    'SF:src/a.ts\nDA:1,1\nend_of_record\nSF:src/a.ts\nDA:1,1\nend_of_record\n',
    'SF:src/a.ts\nDA:1,1\nDA:invalid\nend_of_record\n',
  ]) {
    const data = Buffer.from(text);
    assert.throws(
      () => verifyCoverage(evidence(reference, data), data, reference),
      undefined,
      text,
    );
  }
});

test('accepts type-only LCOV records alongside executable source coverage', () => {
  const data = Buffer.concat([
    lcov,
    Buffer.from('SF:src/types.ts\nLF:0\nLH:0\nend_of_record\n'),
  ]);
  assert.deepEqual(verifyCoverage(evidence(reference, data), data, reference), [
    'src/a.ts',
    'src/types.ts',
  ]);
});

test('rejects mismatched checkout and unsafe analysis context before scanning', (t) => {
  const { source, coverage, env } = checkout(t, 'pull_request');
  for (const override of [
    { ANALYSIS_COMMIT: 'a'.repeat(40) },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { PR_NUMBER: '7\nargs=-Dsonar.qualitygate.wait=false' },
    { GITHUB_HEAD_REF: 'feature -Dsonar.host.url=https://other.invalid' },
    { GITHUB_BASE_REF: 'ENS\n-Dsonar.qualitygate.wait=false' },
    { PULL_REQUEST_HEAD_SHA: 'b'.repeat(40) },
  ]) {
    assert.throws(() => prepare(source, coverage, { ...env, ...override }));
  }
});

test('missing, empty and malformed artifacts cannot become a successful analysis', (t) => {
  for (const file of ['coverage/lcov.info', 'reports/coverage/baseline.json']) {
    const { source, coverage, env } = checkout(t);
    fs.unlinkSync(path.join(coverage, file));
    assert.throws(() => prepare(source, coverage, env));
    write(coverage, file, '');
    assert.throws(() => prepare(source, coverage, env));
    write(coverage, file, '{invalid-json');
    assert.throws(() => prepare(source, coverage, env));
  }
});

test('rejects coverage mapped to absent original sources', (t) => {
  const { source, coverage, env, metadata } = checkout(t);
  const data = Buffer.from('SF:src/missing.ts\nDA:1,1\nend_of_record\n');
  metadata.lcov.sha256 = digest(data);
  write(coverage, 'coverage/lcov.info', data);
  write(coverage, 'reports/coverage/baseline.json', metadata);
  assert.throws(() => prepare(source, coverage, env));
  assert.equal(fs.existsSync(path.join(source, 'coverage/lcov.info')), false);
});

test('rejects symlinked analyzed trees or files', (t) => {
  for (const directory of ['src', 'config', 'test']) {
    const { source, coverage, env } = checkout(t);
    write(path.dirname(source), 'private.ts', 'private-canary');
    fs.symlinkSync(
      path.join(path.dirname(source), 'private.ts'),
      path.join(source, directory, 'escape.ts'),
    );
    assert.throws(() => prepare(source, coverage, env));
  }
});

test('missing identifiers, changed scope or disabled Quality Gate waiting are configuration errors', (t) => {
  for (const [property, replacement] of [
    ['sonar.organization', ''],
    ['sonar.projectKey', ''],
    ['sonar.host.url', 'https://other.invalid'],
    ['sonar.qualitygate.wait', 'false'],
    ['sonar.qualitygate.timeout', '601'],
    ['sonar.javascript.lcov.reportPaths', 'other/lcov.info'],
    ['sonar.sources', 'src'],
    ['sonar.exclusions', '**/*'],
    ['sonar.test.inclusions', '**'],
  ]) {
    const { source, coverage, env } = checkout(t);
    const settings = path.join(source, 'sonar-project.properties');
    const text = fs.readFileSync(settings, 'utf8');
    const prefix = `${property}=`;
    fs.writeFileSync(
      settings,
      text
        .split('\n')
        .map((line) => (line.startsWith(prefix) ? prefix + replacement : line))
        .join('\n'),
    );
    assert.throws(() => prepare(source, coverage, env), undefined, property);
  }
});

test('preparing analysis never persists credentials in arguments or evidence', (t) => {
  const { source, coverage, env } = checkout(t);
  const token = 'canary-canary-canary-canary';
  const result = prepare(source, coverage, { ...env, SONAR_TOKEN: token });
  assert.ok(!JSON.stringify(result).includes(token));
  recordEvidence(result.metadata, 'failure', source, { SONAR_TOKEN: token });
  assert.ok(
    !fs
      .readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8')
      .includes(token),
  );
});

test('unsupported properties are rejected before scanning', (t) => {
  for (const property of [
    'sonar.scanner.skip=true',
    'sonar.scanner.metadataFilePath=other/report-task.txt',
    'sonar.scanner.dumpToFile=scanner-parameters.txt',
    // SonarJS would run this file with the scanner environment and its token.
    'sonar.nodejs.executable=scripts/x.sh',
    'sonar.issue.ignore.multicriteria=e1',
    'sonar.token=canary-canary-canary-canary',
    'sonar.login=canary-canary-canary-canary',
  ]) {
    const { source, coverage, env } = checkout(t);
    fs.appendFileSync(
      path.join(source, 'sonar-project.properties'),
      `\n${property}\n`,
    );
    assert.throws(
      () => prepare(source, coverage, env),
      /Unsupported/,
      property,
    );
  }
});

test('properties that Java would read differently are rejected', (t) => {
  const wait = 'sonar.qualitygate.wait=true';
  const ascii = /printable ASCII/;
  const line = /Invalid or duplicate/;
  for (const [label, edit, error] of [
    // A continuation would join the next line into the exclusions value.
    [
      'continuation',
      (text) => text.replace(/^(sonar\.exclusions=.*)$/m, '$1\\'),
      ascii,
    ],
    ['byte order mark', (text) => `﻿${text}`, ascii],
    ['non-breaking space', (text) => text.replace(wait, `${wait} `), ascii],
    [
      'lone CR in a comment',
      (text) => `# note\rsonar.nodejs.executable=x\n${text}`,
      ascii,
    ],
    ['tab', (text) => text.replace(wait, `${wait}\t`), ascii],
    [
      'spaced separator',
      (text) => text.replace(wait, 'sonar.qualitygate.wait = true'),
      line,
    ],
    [
      'colon separator',
      (text) => text.replace(wait, 'sonar.qualitygate.wait:true'),
      line,
    ],
    ['indented key', (text) => text.replace(wait, `  ${wait}`), line],
  ]) {
    const { source, coverage, env } = checkout(t);
    const settings = path.join(source, 'sonar-project.properties');
    const original = fs.readFileSync(settings, 'utf8');
    const changed = edit(original);
    assert.notEqual(changed, original, label);
    fs.writeFileSync(settings, changed);
    assert.throws(() => prepare(source, coverage, env), error, label);
  }
  const { source, coverage, env } = checkout(t);
  const settings = path.join(source, 'sonar-project.properties');
  fs.writeFileSync(
    settings,
    fs.readFileSync(settings, 'utf8').replace(/\n/g, '\r\n'),
  );
  prepare(source, coverage, env);
});

test('preparation removes native task metadata from an earlier analysis', (t) => {
  const { source, coverage, env } = checkout(t);
  nativeTask(source, 'soltecsis_fwcloud-websrv');
  prepare(source, coverage, env);
  assert.equal(
    fs.existsSync(path.join(source, '.scannerwork/report-task.txt')),
    false,
  );
});

test('successful evidence requires a native task from the configured project and host', (t) => {
  const source = temporary(t);
  const run = { ...reference, projectKey: 'soltecsis_fwcloud-websrv' };
  assert.throws(() => recordEvidence(run, 'success', source, {}));
  for (const text of [
    'serverUrl=https://other.invalid\nprojectKey=soltecsis_fwcloud-websrv\nceTaskId=fixture-task\n',
    'serverUrl=https://sonarcloud.io\nprojectKey=other_project\nceTaskId=fixture-task\n',
    'serverUrl=https://sonarcloud.io\nprojectKey=soltecsis_fwcloud-websrv\n',
    'serverUrl=https://sonarcloud.io\nprojectKey=soltecsis_fwcloud-websrv\nceTaskId=invalid task id\n',
  ]) {
    write(source, '.scannerwork/report-task.txt', text);
    assert.throws(() => recordEvidence(run, 'success', source, {}));
  }
  nativeTask(source, run.projectKey);
  const result = recordEvidence(run, 'success', source, {});
  assert.equal(result.qualityGate, 'PASSED');
  assert.equal(result.ceTaskId, 'fixture-task');
  write(
    source,
    '.scannerwork/report-task.txt',
    'serverUrl=https://sonarcloud.io/\nprojectKey=soltecsis_fwcloud-websrv\nceTaskId=fixture-task\n',
  );
  assert.equal(
    recordEvidence(run, 'success', source, {}).qualityGate,
    'PASSED',
  );
});

test('evidence names the pinned scanner action and CLI version', (t) => {
  const source = temporary(t);
  const run = { ...reference, projectKey: 'soltecsis_fwcloud-websrv' };
  nativeTask(source, run.projectKey);
  const result = recordEvidence(run, 'success', source, {
    GITHUB_ACTIONS: 'true',
  });
  const scan = workflow().jobs.sonar.steps.find((step) => step.id === 'scan');
  assert.equal(result.action, scan.uses);
  assert.equal(result.scannerVersion, scan.with.scannerVersion);
});

test('failed, skipped and cancelled scans cannot claim a passed Quality Gate', (t) => {
  const source = temporary(t);
  write(
    source,
    '.scannerwork/report-task.txt',
    'ceTaskId=task-123\ndashboardUrl=https://other.invalid/dashboard?id=private-canary\n',
  );
  for (const outcome of ['failure', 'skipped', 'cancelled', '']) {
    recordEvidence(reference, outcome, source, {});
    const result = JSON.parse(
      fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
    );
    assert.notEqual(result.qualityGate, 'PASSED');
    assert.equal(result.dashboardUrl, undefined);
    assert.ok(!JSON.stringify(result).includes('private-canary'));
  }
});

test('local analysis accepts a passing baseline for the current checkout', (t) => {
  const { source, commit } = localCheckout(t);
  // Untracked files outside the analyzed trees do not block local analysis.
  write(source, 'notes.txt', 'local notes\n');
  const result = prepare(source, source, {});
  assert.equal(result.metadata.commit, commit);
  assert.ok(result.args.includes(`-Dsonar.scm.revision=${commit}`));
  assert.ok(result.args.includes('-Dsonar.branch.name=feature/local'));
});

test('local analysis refuses CI branches and uncommitted analyzed files', (t) => {
  for (const name of ['main', 'devel', 'ENS', 'ens']) {
    const { source } = localCheckout(t);
    assert.throws(
      () => prepare(source, source, { SONAR_BRANCH: name }),
      /CI analyzes them/,
      name,
    );
  }
  for (const [file, content] of [
    ['src/a.ts', 'export const a = 2;\n'],
    ['src/new.ts', 'export {};\n'],
    ['config/new.ts', 'export {};\n'],
    ['test/b.spec.ts', 'export {};\n'],
  ]) {
    const { source } = localCheckout(t);
    write(source, file, content);
    assert.throws(() => prepare(source, source, {}), /committed/, file);
  }
  const { source } = localCheckout(t);
  fs.appendFileSync(path.join(source, 'sonar-project.properties'), '# local\n');
  assert.throws(() => prepare(source, source, {}), /committed/);
});

test('local scanner receives the token through its environment and propagates failure', (t) => {
  const { source } = localCheckout(t);
  const scanner = fakeScanner(source);
  const token = 'canary-canary-canary-canary';
  const env = {
    ...cleanEnvironment(),
    SONAR_TOKEN: token,
    SONAR_SCANNER_BINARY: scanner,
  };
  for (const code of [0, 1, 5]) {
    assert.equal(
      runScanner(source, { ...env, FAKE_SCANNER_EXIT: String(code) }),
      code,
    );
    const captured = JSON.parse(
      fs.readFileSync(path.join(source, 'scanner-capture.json'), 'utf8'),
    );
    assert.equal(captured.tokenPresent, true);
    assert.ok(!JSON.stringify(captured.args).includes(token));
    const result = JSON.parse(
      fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
    );
    assert.equal(result.qualityGate === 'PASSED', code === 0);
  }
});

test('a scanner that exits zero without submitting fresh analysis cannot pass', (t) => {
  const { source } = localCheckout(t);
  const scanner = fakeScanner(source);
  nativeTask(source, 'soltecsis_fwcloud-websrv');
  const code = runScanner(source, {
    ...cleanEnvironment(),
    SONAR_TOKEN: 'canary-canary-canary-canary',
    SONAR_SCANNER_BINARY: scanner,
    FAKE_SCANNER_SKIP_TASK: 'true',
  });
  assert.equal(code, 1);
  assert.equal(
    fs.existsSync(path.join(source, '.scannerwork/report-task.txt')),
    false,
  );
  const result = JSON.parse(
    fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
  );
  assert.equal(result.qualityGate, 'FAILED_OR_INCOMPLETE');
});

test('the CLI fails explicitly without credentials', (t) => {
  const { source } = localCheckout(t);
  const result = spawnSync(process.execPath, [script], {
    cwd: source,
    env: cleanEnvironment(),
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /SONAR_TOKEN/);
});

test('the CLI prepares native scanner arguments and records failed analysis evidence', (t) => {
  const { source, coverage, env, commit } = checkout(t, 'pull_request');
  const output = path.join(source, 'outputs.txt');
  const token = 'canary-canary-canary-canary';
  const environment = {
    ...cleanEnvironment(),
    ...env,
    GITHUB_OUTPUT: output,
    SONAR_TOKEN: token,
  };
  const prepared = spawnSync(process.execPath, [script, 'prepare', coverage], {
    cwd: source,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const args = fs.readFileSync(output, 'utf8');
  assert.ok(args.includes(`args=-Dsonar.scm.revision=${commit}`));
  assert.ok(args.includes('-Dsonar.pullrequest.key=7'));
  assert.ok(!args.includes(token));
  const context = fs.readFileSync(
    path.join(source, 'reports/sonar/context.json'),
    'utf8',
  );
  assert.ok(!context.includes(token));
  const recorded = spawnSync(process.execPath, [script, 'record'], {
    cwd: source,
    env: { ...environment, SCAN_OUTCOME: 'failure' },
    encoding: 'utf8',
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
  );
  assert.equal(metadata.qualityGate, 'FAILED_OR_INCOMPLETE');
  assert.ok(!JSON.stringify(metadata).includes(token));
});

test('the CLI records failed evidence when a successful scan left no fresh task', (t) => {
  const { source, coverage, env } = checkout(t);
  const environment = {
    ...cleanEnvironment(),
    ...env,
    GITHUB_OUTPUT: path.join(source, 'outputs.txt'),
  };
  const prepared = spawnSync(process.execPath, [script, 'prepare', coverage], {
    cwd: source,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const recorded = spawnSync(process.execPath, [script, 'record'], {
    cwd: source,
    env: { ...environment, SCAN_OUTCOME: 'success' },
    encoding: 'utf8',
  });
  assert.notEqual(recorded.status, 0);
  assert.match(recorded.stderr, /Quality Gate is unverified/);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
  );
  assert.equal(metadata.qualityGate, 'FAILED_OR_INCOMPLETE');
  assert.equal(metadata.scanOutcome, 'failure');
});

test('scanner startup errors return failure and leave incomplete evidence', (t) => {
  const { source } = localCheckout(t);
  const code = runScanner(source, {
    ...cleanEnvironment(),
    SONAR_TOKEN: 'canary-canary-canary-canary',
    SONAR_SCANNER_BINARY: path.join(source, 'absent-scanner'),
  });
  assert.notEqual(code, 0);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(source, 'reports/sonar/metadata.json'), 'utf8'),
  );
  assert.equal(metadata.qualityGate, 'FAILED_OR_INCOMPLETE');
});

function workflow() {
  return yaml.load(
    fs.readFileSync(
      path.join(__dirname, '../.github/workflows/nodejs.yml'),
      'utf8',
    ),
  );
}

test('the analysis consumes only the same workflow reference artifact and uploads safe evidence', () => {
  const ci = workflow();
  const sonar = ci.jobs.sonar;
  // Sources reach SonarQube Cloud only after every other required check passed.
  assert.deepEqual(
    [...sonar.needs].sort(),
    ci.jobs['websrv-ci'].needs.filter((job) => job !== 'sonar').sort(),
  );
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const download = sonar.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  const upload = sonar.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  const scanner = sonar.steps.find((step) => step.id === 'scan');
  const producer = ci.jobs.test.steps.find(
    (step) => step.name === 'Upload coverage reports',
  );
  assert.equal(
    download.with.name,
    'websrv-coverage-node22-${{ github.run_id }}',
  );
  assert.equal(download.with.path, 'coverage-input');
  assert.equal(download.with['run-id'], undefined);
  assert.equal(download.with['github-token'], undefined);
  assert.equal(producer.with.overwrite, true);
  assert.equal(
    producer.with.name,
    'websrv-coverage-node${{ matrix.node-version }}-${{ github.run_id }}',
  );
  assert.equal(upload.with.path, 'reports/sonar/metadata.json');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 90);
  assert.equal(scanner.with.skipSignatureVerification, false);
  assert.equal(scanner.env.SONAR_HOST_URL, 'https://sonarcloud.io');
  assert.match(
    scanner.uses,
    /^SonarSource\/sonarqube-scan-action@[a-f0-9]{40}$/,
  );
  assert.equal(scanner['continue-on-error'], undefined);
  assert.equal(scanner.with.args, '${{ steps.analysis.outputs.args }}');
  // The job holding SONAR_TOKEN runs only commit-pinned actions.
  for (const step of sonar.steps.filter((item) => item.uses)) {
    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/, step.uses);
  }
  // A skipped required check would count as passed in branch protection.
  assert.equal(ci.jobs['websrv-ci'].if, 'always()');
  for (const job of [sonar, ci.jobs['websrv-ci']]) {
    assert.equal(job['continue-on-error'], undefined);
  }
  for (const job of [sonar, ci.jobs.test]) {
    assert.match(
      job.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with
        .ref,
      /github.event.pull_request.head.sha/,
    );
  }
  for (const step of sonar.steps) {
    assert.ok(!/npm (ci|install)|npm run/.test(step.run || ''));
    if (step.env?.SONAR_TOKEN) {
      assert.ok(
        step.id === 'scan' || step.name === 'Require analysis credentials',
      );
    }
  }
});

test('the credential guard rejects a missing token without disclosing it', () => {
  const guard = workflow().jobs.sonar.steps.find(
    (step) => step.name === 'Require analysis credentials',
  );
  const token = 'canary-canary-canary-canary';
  for (const [credential, accepted] of [
    [token, true],
    ['', false],
    [' \n\t', false],
  ]) {
    const result = spawnSync('bash', ['-e', '-c', guard.run], {
      env: { ...cleanEnvironment(), SONAR_TOKEN: credential },
      encoding: 'utf8',
    });
    assert.equal(result.status === 0, accepted, JSON.stringify(credential));
    assert.ok(!(result.stdout + result.stderr).includes(token));
  }
});

test('only fork and Dependabot runs may skip SonarQube', () => {
  const ci = workflow();
  const normalize = (expression) => expression.replace(/\s+/g, ' ').trim();
  const condition = normalize(ci.jobs.sonar.if);
  const gate = ci.jobs['websrv-ci'].steps.find(
    (step) => step.name === 'Check required job results',
  );
  // websrv-ci accepts a skipped analysis exactly where the job is skipped.
  assert.equal(normalize(gate.env.SONAR_REQUIRED), condition);
  for (const clause of [
    "github.actor != 'dependabot[bot]'",
    "github.event_name != 'pull_request'",
    'github.event.pull_request.head.repo.full_name == github.repository',
    "github.event.pull_request.user.login != 'dependabot[bot]'",
  ]) {
    assert.ok(condition.includes(clause), clause);
  }
  // Without a status function, the job only runs after every need succeeded.
  assert.doesNotMatch(condition, /(always|cancelled|failure|success)\(\)/);
});

test('websrv-ci requires a successful analysis unless an ineligible run skipped it', (t) => {
  const ci = workflow();
  const jobs = ci.jobs['websrv-ci'].needs;
  assert.ok(jobs.includes('sonar'));
  const gate = ci.jobs['websrv-ci'].steps.find(
    (step) => step.name === 'Check required job results',
  );
  const summary = path.join(temporary(t), 'summary.md');
  for (const [required, sonar, tests, accepted] of [
    ['true', 'success', 'success', true],
    ['true', 'failure', 'success', false],
    ['true', 'skipped', 'success', false],
    ['true', 'cancelled', 'success', false],
    ['true', 'success', 'failure', false],
    ['false', 'skipped', 'success', true],
    ['false', 'success', 'success', false],
    ['false', 'failure', 'success', false],
    ['false', 'cancelled', 'success', false],
    ['false', 'skipped', 'failure', false],
    ['false', 'skipped', 'skipped', false],
    ['false', 'skipped', 'cancelled', false],
  ]) {
    fs.writeFileSync(summary, '');
    const results = { sonar, test: tests };
    const needs = Object.fromEntries(
      jobs.map((job) => [job, { result: results[job] || 'success' }]),
    );
    const result = spawnSync('bash', ['-e', '-c', gate.run], {
      env: {
        ...cleanEnvironment(),
        NEEDS: JSON.stringify(needs),
        SONAR_REQUIRED: required,
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: 'utf8',
    });
    const label = JSON.stringify({ required, sonar, tests });
    assert.equal(result.status === 0, accepted, label);
    assert.equal(
      fs.readFileSync(summary, 'utf8').includes('SonarQube omitted'),
      required === 'false' && sonar === 'skipped',
      label,
    );
  }
});
