const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./gitleaks-config.json');
// --all traverses every ref; HEAD also covers GitHub's detached PR merge.
// Git omits merge patches by default. Request their first-parent diff without
// restricting traversal of the other parents' history.
const logOptions = '--all HEAD --diff-merges=first-parent';

// Only errors authored here are safe to publish. Native errors may contain
// arbitrary filesystem paths or scanner output.
class ScanError extends Error {}

// Publish locations only. Native reports also contain source matches, commit
// messages and author information, which must never reach logs or artifacts.
function projectFindings(report) {
  if (!Array.isArray(report)) throw new Error('Invalid Gitleaks report.');
  return report.map((finding) => {
    if (
      !finding ||
      typeof finding.RuleID !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/.test(finding.RuleID) ||
      typeof finding.Commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(finding.Commit) ||
      typeof finding.File !== 'string' ||
      !finding.File.length ||
      !Number.isInteger(finding.StartLine) ||
      finding.StartLine < 1 ||
      !Number.isInteger(finding.EndLine) ||
      finding.EndLine < finding.StartLine
    ) {
      throw new Error('Invalid Gitleaks finding.');
    }
    return {
      ruleId: finding.RuleID,
      commit: finding.Commit,
      file: finding.File,
      startLine: finding.StartLine,
      endLine: finding.EndLine,
    };
  });
}

function hasIgnoreFile(root) {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // Do not follow symlinks; a dangling ignore-file symlink is still banned.
      if (entry.name === '.gitleaksignore') return true;
      if (entry.name !== '.git' && entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  return false;
}

function scan(
  root = process.cwd(),
  binary = process.env.GITLEAKS_BINARY || 'gitleaks',
) {
  const metadata = {
    gitleaksVersion: config.version,
    scanScope: 'full-history',
    logOptions,
    exitCode: null,
    status: 'error',
    findingCount: 0,
    findings: [],
    errors: [],
  };
  let temporary;
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new ScanError('Unable to verify Git history.');
    }
    return result.stdout.trim();
  };

  try {
    if (git('rev-parse', '--show-prefix') !== '') {
      throw new ScanError('Run the secret scan from the repository root.');
    }
    if (git('rev-parse', '--is-shallow-repository') !== 'false') {
      throw new ScanError(
        'Full Git history is required; shallow clones are prohibited.',
      );
    }
    metadata.commit = git('rev-parse', '--verify', 'HEAD');
    if (hasIgnoreFile(root)) {
      throw new ScanError('.gitleaksignore files and symlinks are prohibited.');
    }

    // Capture all child output, even errors. Git errors can contain source text
    // or commit messages outside Gitleaks' secret redaction.
    const version = spawnSync(binary, ['version'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (
      version.error ||
      version.status !== 0 ||
      version.stdout.trim() !== config.version
    ) {
      throw new ScanError('The pinned Gitleaks version is unavailable.');
    }

    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'websrv-gitleaks-'));
    const reportPath = path.join(temporary, 'gitleaks.json');
    const ignorePath = path.join(temporary, 'empty-ignore');
    fs.writeFileSync(ignorePath, '', { mode: 0o600 });
    const result = spawnSync(
      binary,
      [
        'git',
        '--config',
        path.join(__dirname, '..', '.gitleaks.toml'),
        `--log-opts=${logOptions}`,
        '--gitleaks-ignore-path',
        ignorePath,
        '--ignore-gitleaks-allow',
        '--redact=100',
        '--exit-code',
        String(config.findingsExitCode),
        '--report-format',
        'json',
        '--report-path',
        reportPath,
        '--timeout',
        String(config.timeoutSeconds),
        '--log-level',
        'error',
        '--no-banner',
        '--no-color',
        '.',
      ],
      {
        cwd: root,
        stdio: 'ignore',
        timeout: (config.timeoutSeconds + 10) * 1000,
        killSignal: 'SIGKILL',
      },
    );
    metadata.exitCode = result.status;
    if (result.error || ![0, config.findingsExitCode].includes(result.status)) {
      throw new ScanError('Gitleaks could not complete the scan.');
    }
    try {
      metadata.findings = projectFindings(
        JSON.parse(fs.readFileSync(reportPath, 'utf8')),
      );
    } catch {
      // Do not publish JSON parser errors: they may include secret values.
      throw new ScanError('Gitleaks did not produce a valid findings report.');
    }
    metadata.findingCount = metadata.findings.length;
    if (
      (result.status === 0 && metadata.findingCount !== 0) ||
      (result.status === config.findingsExitCode && metadata.findingCount === 0)
    ) {
      throw new ScanError(
        'Gitleaks exit code and findings report are inconsistent.',
      );
    }
    metadata.status = metadata.findingCount ? 'findings' : 'success';
  } catch (error) {
    metadata.errors.push(
      error instanceof ScanError
        ? error.message
        : 'Unable to execute the secret scan safely.',
    );
  } finally {
    if (temporary) {
      try {
        fs.rmSync(temporary, { recursive: true, force: true });
      } catch {
        metadata.status = 'error';
        metadata.errors.push('Unable to remove the temporary secret report.');
      }
    }
  }
  return metadata;
}

function main() {
  const metadata = scan();
  const reportDirectory = path.join(process.cwd(), 'reports', 'secrets');
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reportDirectory, 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  const summary = [
    '## Secret detection',
    '',
    `Gitleaks: ${config.version}`,
    'Scope: full Git history (all available refs and HEAD)',
    `Status: ${metadata.status.toUpperCase()}`,
    `Findings: ${metadata.findingCount}`,
    ...metadata.errors,
    'Locations: reports/secrets/metadata.json',
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  process.stdout.write(summary);
  if (metadata.status !== 'success') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stderr.write('Unable to publish secret scan evidence.\n');
    process.exitCode = 1;
  }
}
module.exports = { scan, projectFindings, hasIgnoreFile };
