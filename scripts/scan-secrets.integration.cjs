const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const script = path.join(__dirname, 'scan-secrets.cjs');
const binary = process.env.GITLEAKS_BINARY || 'gitleaks';

// Keep generated fixture credentials out of the repository's own Git history.
const syntheticToken = () =>
  ['gh', 'p_', crypto.randomBytes(18).toString('hex')].join('');

function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('GITLEAKS_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

function git(cwd, ...args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=CI Fixture',
      '-c',
      'user.email=ci@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${os.devNull}`,
      ...args,
    ],
    { cwd, encoding: 'utf8', env: isolatedEnv() },
  );
  assert.equal(result.error, undefined, 'Git fixture command could not run.');
  assert.equal(result.status, 0, 'Git fixture command failed.');
  return result.stdout.trim();
}

function fixture(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'websrv-secrets-integration-'),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  git(dir, '-c', 'init.defaultBranch=main', 'init', '--template=', repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), '/reports/\n');
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    'Secret scan test repository.\n',
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial clean fixture');
  return { dir, repo };
}

function commitFile(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-m', 'Controlled test fixture');
  return git(repo, 'rev-parse', 'HEAD');
}

function scan(f, { cwd = f.repo, env = {} } = {}) {
  const summaryPath = path.join(f.dir, 'summary.md');
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv({
      GITLEAKS_BINARY: binary,
      GITHUB_STEP_SUMMARY: summaryPath,
      ...env,
    }),
  });
  assert.equal(
    result.error,
    undefined,
    'Secret scanner wrapper could not run.',
  );
  const metadataPath = path.join(cwd, 'reports/secrets/metadata.json');
  assert.ok(fs.existsSync(metadataPath), 'Secret scan evidence is missing.');
  const report = fs.readFileSync(metadataPath, 'utf8');
  const summary = fs.existsSync(summaryPath)
    ? fs.readFileSync(summaryPath, 'utf8')
    : '';
  return {
    status: result.status,
    metadata: JSON.parse(report),
    output: result.stdout + result.stderr + report + summary,
  };
}

function noSecretOutput(result, ...tokens) {
  for (const token of tokens) {
    assert.ok(
      !result.output.includes(token),
      'A synthetic credential escaped into scan output or evidence.',
    );
  }
  for (const field of ['Secret', 'Match', 'Message', 'Author', 'Email']) {
    assert.ok(
      !result.metadata.findings.some((finding) => field in finding),
      'The evidence contains a disallowed native report field.',
    );
  }
}

test('a clean complete Git history passes', (t) => {
  const result = scan(fixture(t));
  assert.equal(result.status, 0);
  assert.equal(result.metadata.status, 'success');
  assert.equal(result.metadata.exitCode, 0);
  assert.equal(result.metadata.findingCount, 0);
  assert.deepEqual(result.metadata.findings, []);
});

test('detects a secret removed from the latest working tree', (t) => {
  const f = fixture(t);
  const token = syntheticToken();
  const commit = commitFile(f.repo, 'historical.env', `TOKEN=${token}\n`);
  git(f.repo, 'rm', 'historical.env');
  git(f.repo, 'commit', '-m', 'Remove controlled fixture credential');
  assert.ok(!fs.existsSync(path.join(f.repo, 'historical.env')));

  const result = scan(f);
  assert.equal(result.status, 1);
  assert.equal(result.metadata.status, 'findings');
  assert.equal(result.metadata.exitCode, 5);
  assert.ok(
    result.metadata.findings.some(
      (finding) =>
        finding.commit === commit &&
        finding.file === 'historical.env' &&
        finding.startLine === 1,
    ),
    'The removed credential must identify its historical commit and file.',
  );
  noSecretOutput(result, token);
});

test('includes histories reachable only from remote references and tags', (t) => {
  const f = fixture(t);
  const remoteToken = syntheticToken();
  const tagToken = syntheticToken();

  git(f.repo, 'checkout', '-b', 'remote-fixture');
  const remoteCommit = commitFile(
    f.repo,
    'remote-only.env',
    `TOKEN=${remoteToken}\n`,
  );
  git(f.repo, 'update-ref', 'refs/remotes/origin/remote-fixture', remoteCommit);
  git(f.repo, 'checkout', 'main');
  git(f.repo, 'branch', '-D', 'remote-fixture');

  git(f.repo, 'checkout', '-b', 'tag-fixture');
  const tagCommit = commitFile(f.repo, 'tag-only.env', `TOKEN=${tagToken}\n`);
  git(f.repo, 'tag', 'controlled-history-fixture');
  git(f.repo, 'checkout', 'main');
  git(f.repo, 'branch', '-D', 'tag-fixture');
  assert.ok(!fs.existsSync(path.join(f.repo, 'remote-only.env')));
  assert.ok(!fs.existsSync(path.join(f.repo, 'tag-only.env')));

  const result = scan(f);
  assert.equal(result.status, 1);
  assert.equal(result.metadata.status, 'findings');
  for (const [commit, file] of [
    [remoteCommit, 'remote-only.env'],
    [tagCommit, 'tag-only.env'],
  ]) {
    assert.ok(
      result.metadata.findings.some(
        (finding) => finding.commit === commit && finding.file === file,
      ),
      'An available reference outside the current branch was not scanned.',
    );
  }
  noSecretOutput(result, remoteToken, tagToken);
});

test('includes a detached merge commit with a secret absent from both parents', (t) => {
  const f = fixture(t);
  const token = syntheticToken();
  const base = git(f.repo, 'rev-parse', 'HEAD');
  const mainParent = commitFile(f.repo, 'main.txt', 'Clean main branch.\n');
  git(f.repo, 'checkout', '-b', 'merge-side', base);
  commitFile(f.repo, 'side.txt', 'Clean side branch.\n');
  git(f.repo, 'checkout', 'main');
  git(f.repo, 'merge', '--no-commit', '--no-ff', 'merge-side');
  fs.writeFileSync(path.join(f.repo, 'merge-only.env'), `TOKEN=${token}\n`);
  git(f.repo, 'add', 'merge-only.env');
  const message = path.join(f.dir, 'merge-message.txt');
  fs.writeFileSync(message, `Controlled merge fixture\n\n${token}\n`);
  git(f.repo, 'commit', '-F', message);
  const commit = git(f.repo, 'rev-parse', 'HEAD');

  // Model GitHub's detached PR merge commit: only HEAD keeps it reachable.
  git(f.repo, 'checkout', '--detach');
  git(f.repo, 'update-ref', 'refs/heads/main', mainParent);
  assert.equal(git(f.repo, 'for-each-ref', `--contains=${commit}`), '');
  const result = scan(f);
  assert.equal(result.status, 1);
  assert.equal(result.metadata.status, 'findings');
  assert.ok(
    result.metadata.findings.some(
      (finding) =>
        finding.commit === commit && finding.file === 'merge-only.env',
    ),
    'A secret added by a detached merge commit must be detected.',
  );
  noSecretOutput(result, token);
});

test('inline allow comments cannot suppress a finding', (t) => {
  const f = fixture(t);
  const token = syntheticToken();
  commitFile(f.repo, 'inline.env', `TOKEN=${token} # gitleaks:allow\n`);
  const result = scan(f);
  assert.equal(result.status, 1);
  assert.equal(result.metadata.status, 'findings');
  assert.ok(result.metadata.findingCount > 0);
  noSecretOutput(result, token);
});

for (const kind of ['root', 'nested ignored', 'dangling symlink']) {
  test(`rejects a ${kind} .gitleaksignore file`, (t) => {
    const f = fixture(t);
    const file = path.join(
      f.repo,
      kind === 'nested ignored' ? 'private/.gitleaksignore' : '.gitleaksignore',
    );
    if (kind === 'nested ignored') {
      fs.mkdirSync(path.dirname(file));
      fs.appendFileSync(path.join(f.repo, '.gitignore'), '/private/\n');
    }
    if (kind === 'dangling symlink') fs.symlinkSync('does-not-exist', file);
    else fs.writeFileSync(file, '');

    const result = scan(f);
    assert.equal(result.status, 1);
    assert.equal(result.metadata.status, 'error');
    assert.ok(
      result.metadata.errors.some((error) => error.includes('.gitleaksignore')),
      'The ignore-file policy must explain the failure.',
    );
  });
}

test('refuses a shallow clone instead of reporting a complete scan', (t) => {
  const f = fixture(t);
  commitFile(f.repo, 'second.txt', 'Another clean commit.\n');
  const clone = path.join(f.dir, 'shallow');
  git(
    f.dir,
    'clone',
    '--depth=1',
    '--no-local',
    pathToFileURL(f.repo).href,
    clone,
  );
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  const result = scan(f, { cwd: clone });
  assert.equal(result.status, 1);
  assert.equal(result.metadata.status, 'error');
  assert.ok(
    result.metadata.errors.some((error) => /shallow/i.test(error)),
    'A shallow clone must not be accepted as complete history.',
  );
});

test('a missing scanner executable fails closed', (t) => {
  const f = fixture(t);
  const result = scan(f, {
    env: { GITLEAKS_BINARY: path.join(f.dir, 'missing-scanner') },
  });
  assert.equal(result.status, 1);
  assert.equal(result.metadata.status, 'error');
  assert.ok(result.metadata.errors.length > 0);
});
