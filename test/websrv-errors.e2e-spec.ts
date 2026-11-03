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

    You should have received a copy of the GNU Affero General Public License
    along with FWCloud.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
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

describe('WebsrvService upstream failures (integration)', () => {
  let root: string;
  let upstream: Upstream | undefined;
  let websrv: TestWebsrv | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    interceptPidFile();
    root = createTempDir();
    writeFiles(root, {
      'ui/index.html': '<html>FWCloud frontend</html>',
      'ui/health.txt': 'frontend available',
    });
    upstream = await startUpstream();
    websrv = await createWebsrv({
      host: '127.0.0.1',
      port: 0,
      api_url: upstream.url,
      remove_api_string_from_url: true,
      docroot_ui: path.join(root, 'ui'),
      docroot_ui_doc: path.join(root, 'manual'),
      https: false,
      cert: '',
      key: '',
      ca_bundle: '',
      proxyTimeout: 1000,
    });
    baseUrl = await websrv.start();
  });

  afterEach(async () => {
    try {
      await websrv?.close();
    } finally {
      try {
        await upstream?.close();
      } finally {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        jest.restoreAllMocks();
        websrv = undefined;
        upstream = undefined;
      }
    }
  });

  it('returns and logs a controlled error for an unavailable upstream, then recovers', async () => {
    const port = upstream!.port;
    await upstream!.close();

    const response = await request(`${baseUrl}/api/health?probe=1`);

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.body).toBe('ERROR: Proxing request: /health?probe=1');
    expect(websrv!.log.error).toHaveBeenCalledWith(
      'Proxing request: /health?probe=1 - ',
      expect.objectContaining({ code: 'ECONNREFUSED' }),
    );
    expect(await request(`${baseUrl}/health.txt`)).toMatchObject({
      status: 200,
      body: 'frontend available',
    });

    upstream = await startUpstream({ port });
    expect(await request(`${baseUrl}/api/recovered`)).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe('/recovered');
  });

  it('handles an upstream connection reset before response headers and accepts subsequent requests', async () => {
    upstream!.respond((_req, res) => res.destroy());

    const response = await request(`${baseUrl}/api/interrupted`);

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toBe('text/plain');
    expect(response.body).toBe('ERROR: Proxing request: /interrupted');
    expect(websrv!.log.error).toHaveBeenCalledWith(
      'Proxing request: /interrupted - ',
      expect.objectContaining({ code: 'ECONNRESET' }),
    );

    upstream!.respond((_req, res) => res.end('upstream recovered'));
    expect(await request(`${baseUrl}/api/recovered`)).toMatchObject({
      status: 200,
      body: 'upstream recovered',
    });
    expect(await request(`${baseUrl}/health.txt`)).toMatchObject({
      status: 200,
      body: 'frontend available',
    });
  });

  it('terminates and logs a partially delivered upstream response without crashing', async () => {
    let upstreamResponse: http.ServerResponse;
    upstream!.respond((_req, res) => {
      upstreamResponse = res;
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': '100',
      });
      res.write('partial response');
    });

    // Destroy the upstream only after its first bytes reach the client. This
    // exercises a real interruption after downstream headers have been sent.
    const response = await new Promise<{
      status: number;
      body: string;
      complete: boolean;
    }>((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/api/partial`,
        { agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            upstreamResponse.destroy();
          });
          res.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ECONNRESET') return reject(error);
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              complete: res.complete,
            });
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              complete: res.complete,
            }),
          );
        },
      );
      req.on('error', reject);
      req.setTimeout(2000, () => {
        req.destroy(new Error('The interrupted proxy response was left open'));
      });
    });

    expect(response).toEqual({
      status: 200,
      body: 'partial response',
      complete: false,
    });
    expect(websrv!.log.error).toHaveBeenCalledWith(
      'Proxing request: /partial - ',
      expect.objectContaining({ code: 'ECONNRESET' }),
    );
    upstream!.respond((_req, res) => res.end('upstream recovered'));
    expect(await request(`${baseUrl}/api/recovered`)).toMatchObject({
      status: 200,
      body: 'upstream recovered',
    });
  });
});
