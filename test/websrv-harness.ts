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

// Harness for the WebsrvService integration tests: a mock FWCloud API that
// records requests, an HTTP(S) client, temporary files and TLS certificates,
// and the real service listening on an ephemeral port of 127.0.0.1.

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'child_process';
import { once } from 'events';
// The `fs` module object itself (not a namespace copy), so a `jest.spyOn` on it
// also applies inside WebsrvService.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import fs = require('fs');
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { LogsService } from '../src/logs/logs.service';
import {
  WebsrvService,
  WebsrvServiceConfig,
} from '../src/websrv/websrv.service';

const HOST = '127.0.0.1';

type Server = http.Server | https.Server;

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, HOST);
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fwcloud-websrv-test-'));
}

export function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export interface TlsFiles {
  cert: string;
  key: string;
}

/**
 * Creates `<name>.crt` and `<name>.key` in `dir`: a self-signed certificate for
 * 127.0.0.1, generated with `openssl` like `bin/update-cert.sh` does.
 */
export function createTlsFiles(dir: string, name: string): TlsFiles {
  const files = {
    cert: path.join(dir, `${name}.crt`),
    key: path.join(dir, `${name}.key`),
  };
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${HOST}`,
      '-addext',
      `subjectAltName=IP:${HOST}`,
      '-keyout',
      files.key,
      '-out',
      files.cert,
    ],
    { stdio: 'pipe' },
  );
  return files;
}

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type UpstreamHandler = (
  req: UpstreamRequest,
  res: http.ServerResponse,
) => void;

export interface Upstream {
  url: string;
  port: number;
  /** Requests received so far, in arrival order. */
  requests: UpstreamRequest[];
  /** Replaces the default response: 200 with the body `{"ok":true}`. */
  respond(handler: UpstreamHandler): void;
  close(): Promise<void>;
}

/** Stands in for FWCloud API: records each request, then responds to it. */
export async function startUpstream(
  options: { port?: number; tls?: TlsFiles } = {},
): Promise<Upstream> {
  const requests: UpstreamRequest[] = [];
  let handler: UpstreamHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const received: UpstreamRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(received);
      handler(received, res);
    });
  };
  const server = options.tls
    ? https.createServer(
        {
          cert: fs.readFileSync(options.tls.cert),
          key: fs.readFileSync(options.tls.key),
        },
        onRequest,
      )
    : http.createServer(onRequest);
  const port = await listen(server, options.port);
  return {
    url: `${options.tls ? 'https' : 'http'}://${HOST}:${port}`,
    port,
    requests,
    respond: (next) => {
      handler = next;
    },
    close: () => close(server),
  };
}

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface TestRequestOptions {
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
  /** The only CA trusted for an HTTPS URL. */
  ca?: string | Buffer;
}

/** Sends one request on a new connection and reads the whole response. */
export function request(
  url: string,
  { method = 'GET', headers, body, ca }: TestRequestOptions = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    };
    // Without an agent the connection is closed after the response, so no
    // socket outlives the request.
    const options: https.RequestOptions = { method, headers, ca, agent: false };
    const req = url.startsWith('https:')
      ? https.request(url, options, onResponse)
      : http.request(url, options, onResponse);
    req.setTimeout(3000, () => {
      req.destroy(new Error(`Local test request timed out: ${url}`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export interface LogsMock {
  error: jest.Mock;
  http: jest.Mock;
  info: jest.Mock;
}

export interface TestWebsrv {
  service: WebsrvService;
  log: LogsMock;
  /** Calls `start()` and resolves with the base URL once the server listens. */
  start(): Promise<string>;
  /** Closes the server and its connections, if it is listening. */
  close(): Promise<void>;
}

/**
 * Builds WebsrvService through Nest with the real ConfigService holding
 * `config`. A LogsService mock records the logs instead of writing files.
 */
export async function createWebsrv(
  config: WebsrvServiceConfig,
): Promise<TestWebsrv> {
  const log: LogsMock = { error: jest.fn(), http: jest.fn(), info: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      WebsrvService,
      {
        provide: ConfigService,
        useValue: new ConfigService({ websrv: config }),
      },
      { provide: LogsService, useValue: log },
    ],
  }).compile();
  const service = moduleRef.get(WebsrvService);
  // WebsrvService keeps its server private and has no method to stop it.
  return {
    service,
    log,
    async start() {
      await service.start();
      // start() returns once listen() is called, before the port is bound.
      const server = service['_server'];
      if (!server.listening) await once(server, 'listening');
      const { address, port } = server.address() as AddressInfo;
      return `${config.https ? 'https' : 'http'}://${address}:${port}`;
    },
    async close() {
      try {
        await close(service['_server'] as Server | undefined);
      } finally {
        await moduleRef.close();
      }
    },
  };
}

/**
 * WebsrvService writes `.pid` to the working directory once it listens. This
 * keeps tests from overwriting the PID file of a websrv run from this checkout.
 */
export function interceptPidFile() {
  const writeFileSync = fs.writeFileSync;
  return jest
    .spyOn(fs, 'writeFileSync')
    .mockImplementation((file, data, options) => {
      if (file !== '.pid') writeFileSync(file, data, options);
    });
}

/** Resolves with the exit code instead of letting the service end Jest. */
export function interceptProcessExit(): Promise<
  string | number | null | undefined
> {
  return new Promise((resolve) => {
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      resolve(code);
      return undefined as never;
    });
  });
}
