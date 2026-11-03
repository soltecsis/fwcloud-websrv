/*
    Copyright 2026 SOLTECSIS SOLUCIONES TECNOLOGICAS, SLU
    https://soltecsis.com
    info@soltecsis.com


    This file is part of FWCloud (https://fwcloud.net).

    FWCloud is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    FWCloud is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with FWCloud.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as fs from 'fs';
import * as path from 'path';
import type { WebsrvServiceConfig } from '../src/websrv/websrv.service';
import {
  createTempDir,
  createTlsFiles,
  createWebsrv,
  interceptPidFile,
  interceptProcessExit,
  request,
  startUpstream,
  TestWebsrv,
  TlsFiles,
  writeFiles,
} from './websrv-harness';

describe('WebsrvService HTTP/HTTPS startup (integration)', () => {
  const index = '<!doctype html><title>FWCloud startup test</title>';
  let root: string;
  let tls: TlsFiles;
  let config: WebsrvServiceConfig;
  let websrv: TestWebsrv | undefined;

  beforeAll(() => {
    root = createTempDir();
    writeFiles(root, {
      'ui/index.html': index,
      'invalid.crt': 'This is not a PEM certificate.',
      'invalid.key': 'This is not a PEM private key.',
    });
    tls = createTlsFiles(path.join(root, 'tls'), 'websrv');
  });

  beforeEach(() => {
    interceptPidFile();
    config = {
      host: '127.0.0.1',
      port: 0,
      docroot_ui: path.join(root, 'ui'),
      docroot_ui_doc: path.join(root, 'manual'),
      api_url: 'http://127.0.0.1:1',
      remove_api_string_from_url: true,
      https: false,
      ...tls,
      ca_bundle: '',
      proxyTimeout: 1000,
    };
  });

  afterEach(async () => {
    jest.useRealTimers();
    try {
      await websrv?.close();
    } finally {
      websrv = undefined;
      jest.restoreAllMocks();
    }
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts an HTTP server that completes requests and releases its port', async () => {
    websrv = await createWebsrv(config);
    const url = await websrv.start();

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await request(`${url}/index.html`)).toMatchObject({
      status: 200,
      body: index,
    });
    expect(websrv.log.info).toHaveBeenCalledWith(
      expect.stringContaining('Listening on http://'),
    );
    expect(websrv.log.error).not.toHaveBeenCalled();

    await websrv.close();
    await expect(request(`${url}/index.html`)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it.each([false, true])(
    'starts a trusted HTTPS server with configured CA bundle: %s',
    async (withCaBundle) => {
      websrv = await createWebsrv({
        ...config,
        https: true,
        ca_bundle: withCaBundle ? tls.cert : '',
      });
      const url = await websrv.start();

      expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      // Trust only the generated certificate. TLS verification stays enabled.
      expect(
        await request(`${url}/index.html`, {
          ca: fs.readFileSync(tls.cert),
        }),
      ).toMatchObject({ status: 200, body: index });
      expect(websrv.log.info).toHaveBeenCalledWith(
        expect.stringContaining('Listening on https://'),
      );
      expect(websrv.log.error).not.toHaveBeenCalled();

      await websrv.close();
      await expect(
        request(`${url}/index.html`, { ca: fs.readFileSync(tls.cert) }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    },
  );

  it('proxies HTTPS API requests with the original TLS protocol and port', async () => {
    const upstream = await startUpstream();
    try {
      upstream.respond((_req, res) => {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"tls":true}');
      });
      websrv = await createWebsrv({
        ...config,
        https: true,
        api_url: upstream.url,
      });
      const url = await websrv.start();

      expect(
        await request(`${url}/api/protocol?source=tls`, {
          ca: fs.readFileSync(tls.cert),
        }),
      ).toMatchObject({ status: 202, body: '{"tls":true}' });
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]).toMatchObject({
        method: 'GET',
        url: '/protocol?source=tls',
        headers: {
          'x-forwarded-for': '127.0.0.1',
          'x-forwarded-port': new URL(url).port,
          'x-forwarded-proto': 'https',
        },
      });
      expect(websrv.log.error).not.toHaveBeenCalled();
    } finally {
      await upstream.close();
    }
  });

  it.each([
    ['missing certificate', 'cert', 'missing.crt'],
    ['missing private key', 'key', 'missing.key'],
    ['missing CA bundle', 'ca_bundle', 'missing-ca.crt'],
    ['invalid certificate', 'cert', 'invalid.crt'],
    ['invalid private key', 'key', 'invalid.key'],
  ] as const)(
    'logs a controlled startup failure with %s',
    async (_description, setting, file) => {
      websrv = await createWebsrv({
        ...config,
        https: true,
        [setting]: path.join(root, file),
      });
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const exited = interceptProcessExit();
      jest.useFakeTimers();

      // On startup failure start() waits for process.exit(), so it never
      // resolves. Observe the exit request instead of awaiting that promise.
      void websrv.service.start();
      jest.advanceTimersByTime(100);

      await expect(exited).resolves.toBe(1);
      expect(jest.getTimerCount()).toBe(0);
      expect(websrv.log.error).toHaveBeenCalledTimes(1);
      expect(websrv.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Starting FWCloud WEB server: '),
      );
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Starting FWCloud WEB server: '),
      );
      expect(websrv.log.info).not.toHaveBeenCalled();
    },
  );
});
