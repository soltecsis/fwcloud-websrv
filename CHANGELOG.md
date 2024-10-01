# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 
### Added
- Added logic to redirect to index.html of web server document root path when cant resolve url.
- Added fresh_build_start npm run script.

### Fixed
- Error: `/var/lib/dpkg/info/fwcloud-ui.postinst: 70: [: Disabled: unexpected operator`.
- Updated packages to the last versions.
- Updated npm modules.
- Updated CI with last node versions.

### Changed
- Default value for `FWC_API_URL` config option from `https://localhost:3131` to `https://127.0.0.1:3131`.


## [1.2.3] - 2023-06-07
### Changed
- Config options for FWCloud-UI. Removed the `checkUpdates` config option and added the `installMethod` one with the value `pkg`.


## [1.2.2] - 2023-05-11
### Fixed
- Bugs in DEB/RPM packages GitHub Actions generation process.


## [1.2.1] - 2023-05-04
### Fixed
- Date mistake in `CHANGELOG.md` file.


## [1.2.0] - 2023-05-04
### Added
- Automatically generated packages by means of GitHub Actions for `deb` and `rpm` based Linux distributions.
- `After=fwcloud-api.service` to the `fwcloud-websrv.service` systemd file to make sure that the FWCloud-API service is started before the `fwcloud-websrv` service.
- `Alias=fwcloud-ui.service` to the `fwcloud-websrv.service` systemd file.


## [1.1.2] - 2023-03-09
### Added
- Task in package.json file for TLS certificates update.
- Script for TLS certificate update.

### Fixed
- Overwrite PID file only if service is started successfully.
- Updated npm modules.

### Changed
- If PID file exists, stop before start.


## [1.0.8] - 2022-09-06
### Changed
- Default timeout for proxy requests.

### Fixed
- Updated npm modules.


## [1.0.7] - 2022-02-11
### Added
- Changed documentation default directory.

### Fixed
- Update NestJS to version 8.
- Updated npm modules.


## [1.0.6] - 2021-12-02
### Added
- GitHub CI.

### Fixed
- Updated npm modules.


## [1.0.5] - 2021-09-22
### Fixed
- Updated npm modules.


## [1.0.4] - 2021-03-18
### Added
- FWCloud-UI user's manual static documentation access URL.
- Config options for document root paths of FWCloud-UI and FWCloud-UI-Doc.


## [1.0.3] - 2021-01-25
### Fixed
- Verify that in the proxy `on error` event handler the `res.writeHead()` method is defined before calling it. If fwcloud-api is stopped in the middle of an API call processing, this event handler receives an `EPIPE` error (*This socket has been ended by the other party*) for the websocket and the `res` object doesn't has the `res.writeHead()` method defined. This was triggering a fatal error and the execution end of the fwcloud-websrv process.


## [1.0.2] - 2021-01-15
### Added
- Log fatal startup errors to console.
  
### Changed
- Default proxy timeout value from 300000ms to 600000ms.

### Fixed
- Bug in data type of proxyTimeout configuration parameter when defined in `.env` file.
- Fatal errors not logged into logs file.

### Security
- Updated npm module axios from 0.21.0 to 0.21.1.


## [1.0.1] - 2020-12-04
### Added
- Proxy timeout option for outgoing proxy requests. Some requests (for example, PUT /updates/updater) may take quite time and the default proxyTimeout value of the http-proxy node module can not be enoght.


## [1.0.0] - 2020-12-01
### Added
- Logs service.
- Log all proxied requests to the file 'logs/http.log'.
- New scripts in package.json for start, stop and update.
- Store pid in .pid file.
- Npm script for stop process using the pid stored in .pid file.
- SGTERM and SIGINT signal handlers.