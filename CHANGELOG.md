# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.2] - 2021-01-15
### Added
- Log fatal startup errors to console.
  
### Changed
- Default proxy timeout value from 300000ms to 600000ms.

### Fixed
- Bug in data type of proxyTimeout configuration parameter when defined in `.env` file.
- Fatal errors not logged into logs file.

### Security
- Updated npm module axios from 0.21.0 to 0.21.1.


## [1.0.1] - 2020-12-04
### Added
- Proxy timeout option for outgoing proxy requests. Some requests (for example, PUT /updates/updater) may take quite time and the default proxyTimeout value of the http-proxy node module can not be enoght.

## [1.0.0] - 2020-12-01
### Added
- Logs service.
- Log all proxied requests to the file 'logs/http.log'.
- New scripts in package.json for start, stop and update.
- Store pid in .pid file.
- Npm script for stop process using the pid stored in .pid file.
- SGTERM and SIGINT signal handlers.