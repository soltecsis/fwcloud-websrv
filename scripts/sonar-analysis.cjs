// Adapted from fwcloud-api/scripts/sonar-analysis.cjs. The official scanner
// performs analysis and Quality Gate polling; this helper validates its inputs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const ACTION =
  'SonarSource/sonarqube-scan-action@d209202bc7d53ff1cc128f7f907dac145c9d6ae9';
const SCANNER_VERSION = '8.1.0.6389';
const HOST = 'https://sonarcloud.io';
// Analysis scope and Quality Gate settings. sonar-project.properties must
// contain these exact values; change both together.
const PINNED = {
  'sonar.host.url': HOST,
  'sonar.sources': 'src,config',
  'sonar.tests': 'src,test',
  'sonar.test.inclusions': '**/*.spec.ts,**/*.e2e-spec.ts,test/**',
  'sonar.exclusions':
    '**/node_modules/**,**/dist/**,**/coverage/**,**/reports/**,**/.scannerwork/**,**/*.d.ts,**/*.spec.ts,**/*.e2e-spec.ts',
  'sonar.javascript.lcov.reportPaths': 'coverage/lcov.info',
  'sonar.sourceEncoding': 'UTF-8',
  'sonar.qualitygate.wait': 'true',
};
// Other keys could change the scope, suppress issues or run other tools.
const PROPERTIES = new Set([
  ...Object.keys(PINNED),
  'sonar.organization',
  'sonar.projectKey',
  'sonar.qualitygate.timeout',
]);
// CI analyzes these branches; local analysis must not replace their results.
const CI_BRANCHES = ['main', 'devel', 'ens'];
const must = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const validAttempt = (value) =>
  ['number', 'string'].includes(typeof value) &&
  /^[1-9]\d*$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));
const branch = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/.test(value);

function regularFile(file) {
  must(
    fs.lstatSync(file, { throwIfNoEntry: false })?.isFile(),
    'A required analysis input is missing or is not a regular file.',
  );
  return fs.readFileSync(file);
}

function directory(directoryPath) {
  must(
    fs.lstatSync(directoryPath, { throwIfNoEntry: false })?.isDirectory(),
    'An analysis directory is missing or is a symlink.',
  );
}

function settings(source, env) {
  const content = regularFile(path.join(source, 'sonar-project.properties'));
  const text = content.toString('latin1');
  // The scanner reads this file with java.util.Properties, which also accepts
  // escapes, line continuations, lone CR line breaks and other whitespace.
  // Plain ASCII key=value lines read the same in both parsers.
  must(
    content.every(
      (byte) =>
        byte === 0x0a ||
        byte === 0x0d ||
        (byte >= 0x20 && byte <= 0x7e && byte !== 0x5c),
    ) && !/\r(?!\n)/.test(text),
    'sonar-project.properties must be printable ASCII without backslashes.',
  );
  const properties = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^ *$/.test(line) || /^[#!]/.test(line)) continue;
    const match = line.match(/^(sonar\.[A-Za-z0-9._-]+)=(\S(?:.*\S)?)$/);
    must(
      match && !(match[1] in properties),
      'Invalid or duplicate Sonar property; use key=value without spaces around it.',
    );
    must(
      PROPERTIES.has(match[1]),
      `Unsupported Sonar property ${match[1]}; analysis credentials come from SONAR_TOKEN.`,
    );
    properties[match[1]] = match[2];
  }
  for (const [key, value] of Object.entries(PINNED)) {
    must(properties[key] === value, `${key} must be ${value}.`);
  }
  must(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(
      properties['sonar.organization'] || '',
    ) &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,399}$/.test(
        properties['sonar.projectKey'] || '',
      ),
    'Missing or invalid SonarQube Cloud organization/project key.',
  );
  must(
    /^[1-9]\d*$/.test(properties['sonar.qualitygate.timeout'] || '') &&
      Number(properties['sonar.qualitygate.timeout']) <= 600,
    'The Quality Gate timeout must be 1 to 600 seconds.',
  );
  must(
    !env.SONAR_HOST_URL || env.SONAR_HOST_URL === HOST,
    'Analysis must use the configured SonarQube Cloud host.',
  );
  return { properties, hash: sha256(content) };
}

function verifyCoverage(metadata, lcov, run) {
  const mismatched = [
    'repository',
    'commit',
    'event',
    'ref',
    'pullRequestHeadCommit',
  ].filter((key) => metadata[key] !== run[key]);
  if (String(metadata.runId) !== String(run.runId)) mismatched.push('runId');
  must(
    mismatched.length === 0,
    `Coverage does not belong to the selected revision/execution: ${mismatched.join(', ')}.`,
  );
  const local = run.runId === null;
  must(
    local
      ? metadata.runAttempt === null && run.runAttempt === null
      : validAttempt(metadata.runAttempt) &&
          validAttempt(run.runAttempt) &&
          Number(metadata.runAttempt) <= Number(run.runAttempt),
    'Coverage producer attempt must be valid and not newer than analysis.',
  );
  must(
    metadata.schemaVersion === 1 &&
      metadata.testOutcome === 'success' &&
      metadata.coverageExpected === true &&
      /^v22\./.test(metadata.node || '') &&
      Number.isSafeInteger(metadata.tests?.numTotalTests) &&
      metadata.tests.numTotalTests > 0 &&
      metadata.tests.numFailedTests === 0 &&
      metadata.tests.numFailedTestSuites === 0 &&
      metadata.coverage?.lines?.total > 0 &&
      Array.isArray(metadata.errors) &&
      metadata.errors.length === 0,
    'Reference evidence requires complete, successful Node.js 22 tests and coverage.',
  );
  must(
    lcov.length > 0 &&
      lcov.length < 25 * 1024 * 1024 &&
      metadata.lcov?.path === 'coverage/lcov.info' &&
      metadata.lcov.sha256 === sha256(lcov),
    'Missing, oversized or altered LCOV.',
  );
  const text = lcov.toString('utf8').replace(/\r\n/g, '\n');
  const files = text
    .split('\n')
    .filter((line) => line.startsWith('SF:'))
    .map((line) => line.slice(3));
  const records = text.split(/^end_of_record$/m);
  const trailing = records.pop();
  must(
    files.length > 0 &&
      new Set(files).size === files.length &&
      files.length === records.length &&
      !trailing.trim() &&
      /^DA:[1-9]\d*,\d+(?:,[^\n]*)?$/m.test(text) &&
      records.every((record) => {
        const lines = record.split('\n');
        const data = lines.filter((line) => line.startsWith('DA:'));
        // Type-only modules can legitimately contain no executable lines.
        return (
          lines.filter((line) => line.startsWith('SF:')).length === 1 &&
          (data.length > 0 ||
            (lines.includes('LF:0') && lines.includes('LH:0'))) &&
          data.every((line) => /^DA:[1-9]\d*,\d+(?:,[^\n]*)?$/.test(line))
        );
      }),
    'LCOV has no complete source coverage records.',
  );
  must(
    files.every(
      (file) =>
        /^src\/.+\.(ts|js)$/.test(file) &&
        !/\.(?:d|spec|e2e-spec)\.ts$/.test(file) &&
        !file
          .split('/')
          .some((part) =>
            ['..', '.', '', 'node_modules', 'dist', 'coverage'].includes(part),
          ) &&
        !/[\x00-\x20\\]/.test(file),
    ),
    'LCOV must reference relative original application sources only.',
  );
  return files;
}

function prepare(source, coverageInput, env = process.env) {
  const { properties, hash } = settings(source, env);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const ci = env.GITHUB_ACTIONS === 'true';
  const run = {
    repository: ci ? env.GITHUB_REPOSITORY : null,
    commit,
    event: ci ? env.GITHUB_EVENT_NAME : null,
    ref: ci ? env.GITHUB_REF : null,
    pullRequestHeadCommit: ci ? env.PULL_REQUEST_HEAD_SHA || null : null,
    runId: ci ? env.GITHUB_RUN_ID : null,
    runAttempt: ci ? env.GITHUB_RUN_ATTEMPT : null,
    branch: ci
      ? env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME
      : env.SONAR_BRANCH ||
        execFileSync('git', ['branch', '--show-current'], {
          cwd: source,
          encoding: 'utf8',
        }).trim(),
    base: null,
    pr: null,
  };
  must(/^[a-f0-9]{40}$/.test(commit), 'Invalid checkout revision.');
  if (ci) {
    must(
      commit === env.ANALYSIS_COMMIT,
      'Checkout differs from the tested revision.',
    );
    must(
      ['push', 'pull_request'].includes(run.event) &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(run.repository || '') &&
        typeof run.ref === 'string' &&
        run.ref.startsWith('refs/') &&
        validAttempt(run.runId) &&
        validAttempt(run.runAttempt),
      'Missing or unsupported GitHub Actions context.',
    );
    must(
      run.event === 'pull_request'
        ? run.pullRequestHeadCommit === commit
        : !run.pullRequestHeadCommit && env.GITHUB_SHA === commit,
      'Analysis does not match the push or pull request head.',
    );
  }
  must(
    branch(run.branch),
    ci
      ? 'Invalid source branch.'
      : 'Invalid source branch; set SONAR_BRANCH for a detached local checkout.',
  );
  if (!ci) {
    must(
      !CI_BRANCHES.includes(run.branch.toLowerCase()),
      'Local analysis cannot publish main, devel or ENS; CI analyzes them.',
    );
    const changes = execFileSync(
      'git',
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        'src',
        'config',
        'test',
        'sonar-project.properties',
      ],
      { cwd: source, encoding: 'utf8' },
    );
    must(
      !changes.trim(),
      'Local analysis requires committed src, config, test and sonar-project.properties.',
    );
  }
  const args = [
    `-Dsonar.scm.revision=${commit}`,
    // Command-line values override the file, so the scanner always waits.
    '-Dsonar.qualitygate.wait=true',
    `-Dsonar.qualitygate.timeout=${properties['sonar.qualitygate.timeout']}`,
  ];
  if (run.event === 'pull_request') {
    must(
      validAttempt(env.PR_NUMBER) && branch(env.GITHUB_BASE_REF),
      'Invalid pull request context.',
    );
    run.pr = Number(env.PR_NUMBER);
    run.base = env.GITHUB_BASE_REF;
    args.push(
      `-Dsonar.pullrequest.key=${run.pr}`,
      `-Dsonar.pullrequest.branch=${run.branch}`,
      `-Dsonar.pullrequest.base=${run.base}`,
    );
  } else args.push(`-Dsonar.branch.name=${run.branch}`);

  // Check each directory component before reading artifact files.
  for (const part of ['', 'coverage', 'reports', 'reports/coverage']) {
    directory(path.join(coverageInput, part));
  }
  let metadata;
  try {
    metadata = JSON.parse(
      regularFile(path.join(coverageInput, 'reports/coverage/baseline.json')),
    );
  } catch {
    throw new Error('Missing or invalid reference coverage baseline.');
  }
  const lcov = regularFile(path.join(coverageInput, 'coverage/lcov.info'));
  const files = verifyCoverage(metadata, lcov, run);
  const walk = (directoryPath) => {
    directory(directoryPath);
    for (const entry of fs.readdirSync(directoryPath, {
      withFileTypes: true,
    })) {
      must(
        !entry.isSymbolicLink(),
        'Symlinks are not allowed in analyzed source trees.',
      );
      if (entry.isDirectory()) walk(path.join(directoryPath, entry.name));
    }
  };
  for (const part of ['src', 'config', 'test']) walk(path.join(source, part));
  for (const file of files) regularFile(path.join(source, file));
  for (const part of ['coverage', 'reports', 'reports/sonar']) {
    fs.mkdirSync(path.join(source, part), { recursive: true });
    directory(path.join(source, part));
  }
  const destination = path.join(source, 'coverage/lcov.info');
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  must(
    !existing || existing.isFile(),
    'LCOV destination must be a regular file.',
  );
  fs.writeFileSync(path.join(source, 'coverage/lcov.info'), lcov);
  // A scanner that exits without submitting analysis must not reuse a prior task.
  const work = path.join(source, '.scannerwork');
  if (fs.existsSync(work)) {
    directory(work);
    fs.rmSync(path.join(work, 'report-task.txt'), { force: true });
  }
  return {
    metadata: {
      ...run,
      organization: properties['sonar.organization'],
      projectKey: properties['sonar.projectKey'],
      coverageRunAttempt:
        metadata.runAttempt === null ? null : Number(metadata.runAttempt),
      coverageReportSha256: sha256(lcov),
      scannerSettingsSha256: hash,
    },
    args: args.join(' '),
  };
}

function recordEvidence(run, outcome, source = '.', env = process.env) {
  let taskId;
  if (outcome === 'success') {
    let task;
    try {
      directory(path.join(source, '.scannerwork'));
      task = Object.fromEntries(
        regularFile(path.join(source, '.scannerwork/report-task.txt'))
          .toString('utf8')
          .split('\n')
          .filter((line) => line.includes('='))
          .map((line) => [
            line.slice(0, line.indexOf('=')),
            line.slice(line.indexOf('=') + 1).trim(),
          ]),
      );
    } catch {
      throw new Error(
        'Successful scanner exit has no fresh analysis task; Quality Gate is unverified.',
      );
    }
    must(
      (task.serverUrl || '').replace(/\/+$/, '') === HOST &&
        task.projectKey === run.projectKey &&
        /^[A-Za-z0-9_-]{1,100}$/.test(task.ceTaskId || ''),
      'Invalid native analysis task; Quality Gate is unverified.',
    );
    taskId = task.ceTaskId;
  }
  // Explicit fields only: no token, scanner logs, snippets or .scannerwork.
  const fields = [
    'repository',
    'commit',
    'event',
    'ref',
    'pullRequestHeadCommit',
    'runId',
    'runAttempt',
    'branch',
    'base',
    'pr',
    'organization',
    'projectKey',
    'coverageRunAttempt',
    'coverageReportSha256',
    'scannerSettingsSha256',
  ];
  const result = {
    ...Object.fromEntries(fields.map((key) => [key, run[key]])),
    analyzedAt: new Date().toISOString(),
    scanOutcome: ['success', 'failure', 'cancelled', 'skipped'].includes(
      outcome,
    )
      ? outcome
      : 'unknown',
    qualityGate: outcome === 'success' ? 'PASSED' : 'FAILED_OR_INCOMPLETE',
    action: env.GITHUB_ACTIONS === 'true' ? ACTION : null,
  };
  if (env.GITHUB_ACTIONS === 'true') result.scannerVersion = SCANNER_VERSION;
  if (taskId) result.ceTaskId = taskId;
  fs.mkdirSync(path.join(source, 'reports/sonar'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'reports/sonar/metadata.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  const text = `## Websrv SonarQube analysis\n\nRevision: \`${run.commit}\`\n\nQuality Gate: **${result.qualityGate}**\n`;
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  console.log(text.trimEnd());
  return result;
}

function runScanner(source = '.', env = process.env) {
  must(
    typeof env.SONAR_TOKEN === 'string' && env.SONAR_TOKEN.trim(),
    'Missing SONAR_TOKEN; analysis and Quality Gate cannot run.',
  );
  const { metadata, args } = prepare(source, source, env);
  const result = spawnSync(
    env.SONAR_SCANNER_BINARY || 'sonar-scanner',
    args.split(' '),
    {
      cwd: source,
      env: { ...env, SONAR_HOST_URL: HOST },
      stdio: 'inherit',
    },
  );
  let code =
    !result.error && !result.signal && Number.isInteger(result.status)
      ? result.status
      : 1;
  try {
    recordEvidence(metadata, code === 0 ? 'success' : 'failure', source, env);
  } catch (error) {
    recordEvidence(metadata, 'failure', source, env);
    console.error(error.message);
    code = 1;
  }
  if (result.error)
    console.error(
      'Unable to start SonarScanner; install the documented CLI and check SONAR_SCANNER_BINARY.',
    );
  return code;
}

if (require.main === module) {
  try {
    const command = process.argv[2] || 'scan';
    if (command === 'prepare') {
      const result = prepare('.', process.argv[3] || 'coverage-input');
      fs.writeFileSync(
        'reports/sonar/context.json',
        `${JSON.stringify(result.metadata, null, 2)}\n`,
      );
      must(
        process.env.GITHUB_OUTPUT,
        'prepare requires GITHUB_OUTPUT. Use the default command for local analysis.',
      );
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `args=${result.args}\n`);
    } else if (command === 'record') {
      const run = JSON.parse(regularFile('reports/sonar/context.json'));
      try {
        recordEvidence(run, process.env.SCAN_OUTCOME);
      } catch (error) {
        // Keep the evidence artifact, but never as a passed Quality Gate.
        recordEvidence(run, 'failure');
        throw error;
      }
    } else {
      must(
        command === 'scan',
        'Usage: node scripts/sonar-analysis.cjs [scan|prepare|record]',
      );
      process.exitCode = runScanner();
    }
  } catch (error) {
    console.error(`[sonar] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyCoverage, prepare, recordEvidence, runScanner };
