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
import { WebsrvServiceConfig } from '../src/websrv/websrv.service';
import {
  createTempDir,
  createWebsrv,
  interceptPidFile,
  request,
  startUpstream,
  TestWebsrv,
  Upstream,
  writeFiles,
} from './websrv-harness';

const INDEX = '<!doctype html><title>FWCloud test frontend</title>';
const SCRIPT = 'console.log("frontend asset");';
const MANUAL = '<!doctype html><title>FWCloud test manual</title>';

describe('WebsrvService proxy and static files (integration)', () => {
  let tempDir: string;
  let upstream: Upstream | undefined;
  let websrv: TestWebsrv | undefined;

  beforeEach(async () => {
    interceptPidFile();
    tempDir = createTempDir();
    writeFiles(tempDir, {
      'ui/index.html': INDEX,
      'ui/assets/app.js': SCRIPT,
      'ui/manual/guide.html': 'This UI file must not shadow the manual',
      'ui/api/health': 'This UI file must not shadow the API',
      'docs/index.html': MANUAL,
      'docs/guide.html': '<p>Documentation asset</p>',
    });
    upstream = await startUpstream();
  });

  afterEach(async () => {
    try {
      await websrv?.close();
    } finally {
      try {
        await upstream?.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        jest.restoreAllMocks();
        websrv = undefined;
        upstream = undefined;
      }
    }
  });

  async function start(config: Partial<WebsrvServiceConfig> = {}) {
    websrv = await createWebsrv({
      host: '127.0.0.1',
      port: 0,
      api_url: upstream!.url,
      remove_api_string_from_url: false,
      docroot_ui: path.join(tempDir, 'ui'),
      docroot_ui_doc: path.join(tempDir, 'docs'),
      https: false,
      cert: '',
      key: '',
      ca_bundle: '',
      proxyTimeout: 1000,
      ...config,
    });
    return websrv.start();
  }

  describe('API routing', () => {
    it.each(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])(
      'preserves the %s method, query parameters and request body',
      async (method) => {
        const url = await start();
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
          ? JSON.stringify({ name: 'Firewall España', enabled: true })
          : '';
        const route = '/api/firewalls?name=edge%20one&tag=a&tag=b&path=%2Ftest';

        const response = await request(`${url}${route}`, {
          method,
          body,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        });

        expect(response.status).toBe(200);
        expect(upstream!.requests).toHaveLength(1);
        expect(upstream!.requests[0]).toMatchObject({
          method,
          url: route,
          body,
        });
      },
    );

    it.each([true, false])(
      'applies remove_api_string_from_url=%s only to the leading prefix',
      async (removePrefix) => {
        const url = await start({ remove_api_string_from_url: removePrefix });
        const route = '/api/firewalls/api/policies?next=%2Fapi%2Fobjects';

        await request(`${url}${route}`);

        expect(upstream!.requests).toHaveLength(1);
        expect(upstream!.requests[0].url).toBe(
          removePrefix
            ? '/firewalls/api/policies?next=%2Fapi%2Fobjects'
            : route,
        );
      },
    );

    it.each([201, 302, 404, 503])(
      'returns an upstream %s response with its body and headers',
      async (status) => {
        upstream!.respond((_req, res) => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'x-request-id': 'upstream-response',
            'set-cookie': ['session=abc; HttpOnly', 'language=en'],
            location: '/api/firewalls/42',
          });
          res.end('{"message":"from upstream"}');
        });
        const url = await start();

        const response = await request(`${url}/api/firewalls`);

        expect(response).toMatchObject({
          status,
          body: '{"message":"from upstream"}',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-request-id': 'upstream-response',
            'set-cookie': ['session=abc; HttpOnly', 'language=en'],
            location: '/api/firewalls/42',
          },
        });
      },
    );

    it('forwards request headers and logs the original request URL', async () => {
      const url = await start({ remove_api_string_from_url: true });
      const route = '/api/firewalls?enabled=true';

      await request(`${url}${route}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer local-test-token',
          cookie: 'session=local-test-session',
          accept: 'application/json',
          'x-request-id': 'client-request',
        },
        body: 'test payload',
      });

      expect(upstream!.requests[0].headers).toMatchObject({
        authorization: 'Bearer local-test-token',
        cookie: 'session=local-test-session',
        accept: 'application/json',
        'x-request-id': 'client-request',
        host: new URL(url).host,
      });
      expect(websrv!.log.http).toHaveBeenCalledTimes(1);
      expect(websrv!.log.http).toHaveBeenCalledWith(
        `127.0.0.1|HTTP/1.1|POST|${route}`,
      );
    });
  });

  describe('HTTP headers', () => {
    it('preserves an explicit Origin even when Referer has another origin', async () => {
      const url = await start();

      await request(`${url}/api/headers`, {
        headers: {
          origin: 'https://explicit.example:8443',
          referer: 'https://referer.example/screen',
        },
      });

      expect(upstream!.requests[0].headers).toMatchObject({
        origin: 'https://explicit.example:8443',
        referer: 'https://referer.example/screen',
      });
    });

    it.each([
      [
        'https://frontend.example/dashboard?tab=rules',
        'https://frontend.example',
      ],
      ['http://frontend.example:8080/', 'http://frontend.example:8080'],
    ])(
      'derives Origin from Referer %s when Origin is absent',
      async (referer, origin) => {
        const url = await start();

        await request(`${url}/api/headers`, { headers: { referer } });

        expect(upstream!.requests[0].headers).toMatchObject({
          origin,
          referer,
        });
      },
    );

    it('forwards an empty Origin when both Origin and Referer are absent', async () => {
      const url = await start();

      const response = await request(`${url}/api/headers`);

      expect(response.status).toBe(200);
      expect(upstream!.requests[0].headers.origin).toBe('');
      expect(upstream!.requests[0].headers.referer).toBeUndefined();
    });

    it('adds forwarded client address, port, protocol and host', async () => {
      const url = await start();

      await request(`${url}/api/headers`);

      expect(upstream!.requests[0].headers).toMatchObject({
        'x-forwarded-for': '127.0.0.1',
        'x-forwarded-port': new URL(url).port,
        'x-forwarded-proto': 'http',
        'x-forwarded-host': new URL(url).host,
      });
    });

    it('appends forwarded request information to existing forwarding headers', async () => {
      const url = await start();

      await request(`${url}/api/headers`, {
        headers: {
          'x-forwarded-for': '192.0.2.10',
          'x-forwarded-port': '443',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'frontend.example',
        },
      });

      expect(upstream!.requests[0].headers).toMatchObject({
        'x-forwarded-for': '192.0.2.10,127.0.0.1',
        'x-forwarded-port': `443,${new URL(url).port}`,
        'x-forwarded-proto': 'https,http',
        'x-forwarded-host': 'frontend.example',
      });
    });
  });

  describe('static files', () => {
    it('serves a frontend asset from docroot_ui', async () => {
      const url = await start();

      const response = await request(`${url}/assets/app.js`);

      expect(response.status).toBe(200);
      expect(response.body).toBe(SCRIPT);
      expect(response.headers['content-type']).toMatch(/javascript/);
      expect(upstream!.requests).toHaveLength(0);
    });

    it.each([
      ['/manual/', MANUAL],
      ['/manual/guide.html', '<p>Documentation asset</p>'],
    ])('serves %s from docroot_ui_doc', async (route, content) => {
      const url = await start();

      const response = await request(`${url}${route}`);

      expect(response.status).toBe(200);
      expect(response.body).toBe(content);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(upstream!.requests).toHaveLength(0);
    });

    it.each(['/', '/firewalls/42/rules?tab=filter'])(
      'serves the configured index.html for %s',
      async (route) => {
        const url = await start();

        const response = await request(`${url}${route}`);

        expect(response.status).toBe(200);
        expect(response.body).toBe(INDEX);
        expect(response.headers['content-type']).toMatch(/text\/html/);
        expect(upstream!.requests).toHaveLength(0);
      },
    );

    it('proxies an API request before considering frontend assets', async () => {
      const url = await start();

      const response = await request(`${url}/api/health`);

      expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
      expect(upstream!.requests).toHaveLength(1);
      expect(upstream!.requests[0].url).toBe('/api/health');
    });

    it('returns an upstream API 404 instead of the frontend fallback', async () => {
      upstream!.respond((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"API route not found"}');
      });
      const url = await start();

      const response = await request(`${url}/api/missing`);

      expect(response).toMatchObject({
        status: 404,
        body: '{"error":"API route not found"}',
      });
      expect(upstream!.requests).toHaveLength(1);
    });
  });
});
