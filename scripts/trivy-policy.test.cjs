const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const config = require('./trivy-config.json');

test(
  'native Trivy enforces severity regardless of fix availability and rejects invalid reports',
  { skip: !process.env.TRIVY_BINARY },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'websrv-native-trivy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reportPath = path.join(root, 'trivy.json');
    const check = () =>
      spawnSync(
        process.env.TRIVY_BINARY,
        [
          'convert',
          '--config',
          '/dev/null',
          '--ignorefile',
          '/dev/null',
          '--quiet',
          '--format',
          'json',
          '--scanners',
          'vuln',
          '--severity',
          config.blockingSeverities.join(','),
          '--exit-code',
          String(config.findingsExitCode),
          reportPath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
    for (const severity of ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      for (const fixed of [false, true]) {
        const input = JSON.stringify({
          SchemaVersion: 2,
          ArtifactType: 'repository',
          Results: [
            {
              Target: 'package-lock.json',
              Class: 'lang-pkgs',
              Type: 'npm',
              Vulnerabilities: [
                {
                  VulnerabilityID: 'CVE-2099-0001',
                  PkgName: 'synthetic-package',
                  InstalledVersion: '1.0.0',
                  Severity: severity,
                  ...(fixed ? { FixedVersion: '1.0.1' } : {}),
                },
              ],
            },
          ],
        });
        fs.writeFileSync(reportPath, input);
        const result = check();
        assert.equal(
          result.status,
          config.blockingSeverities.includes(severity)
            ? config.findingsExitCode
            : 0,
          `${severity} (fixed: ${fixed}): ${result.error || result.stderr}`,
        );
        assert.equal(fs.readFileSync(reportPath, 'utf8'), input);
      }
    }
    fs.writeFileSync(reportPath, '{}broken');
    assert.equal(check().status, 1);
    fs.unlinkSync(reportPath);
    assert.equal(check().status, 1);
  },
);
