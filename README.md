# fwcloud-websrv

Web server and API proxy for the FWCloud project

## Tests

Use Node.js 20, 22 or 24 and install dependencies with `npm ci`. Integration tests
also require `openssl` on `PATH` to generate temporary, self-signed TLS certificates.

```bash
npm test           # Unit and integration tests
npm run test:e2e   # Integration tests only
npm run test:cov   # Complete suite with coverage
```

Integration tests start the real `WebsrvService` and mock upstream servers on
ephemeral loopback ports. Frontend assets, documentation and TLS files are created
in temporary directories and removed during teardown. No running FWCloud API,
production certificates or external network access is needed. The tests intercept
PID file writes so they do not overwrite the `.pid` file of a running server.

The same suites run on every supported Node.js version in CI. See
[the CI documentation](.github/CI-WEBSRV.md) for reporting commands and artifacts.
