/*
    Copyright 2025 SOLTECSIS SOLUCIONES TECNOLOGICAS, SLU
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

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientRequest } from 'http';
import { Request } from 'express';
import { LogsService } from '../logs/logs.service';
import * as https from 'https';
import * as http from 'http';
import * as httpProxy from 'http-proxy';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';

export type WebsrvServiceConfig = {
  host: string;
  port: number;
  docroot_ui: string;
  docroot_ui_doc: string;
  api_url: string;
  remove_api_string_from_url: boolean;
  https: boolean;
  cert: string;
  key: string;
  ca_bundle: string;
  proxyTimeout: number | string;
};

@Injectable()
export class WebsrvService {
  private _cfg: WebsrvServiceConfig;
  private _express: express.Application;
  private _server: https.Server | http.Server;
  private _proxy: httpProxy;

  constructor(
    private configService: ConfigService,
    private log: LogsService,
  ) {
    this._cfg = this.configService.get('websrv');

    this._express = express();

    try {
      this._proxy = httpProxy.createProxyServer({
        target: this._cfg.api_url,
        secure: false,
        ws: true,
        xfwd: true, // Add x-forwarded-for, x-forwarded-port, x-forwarded-proto headers
        proxyTimeout:
          typeof this._cfg.proxyTimeout === 'string'
            ? parseInt(this._cfg.proxyTimeout)
            : this._cfg.proxyTimeout,
      });
    } catch (err: any) {
      const msg = `Error creating proxy server: ${(err as Error).message}`;
      this.log.error(msg);
      console.error(msg);
      process.exit(err as number);
    }
  }

  private async proxySetup(): Promise<void> {
    try {
      // Proxy API calls.
      this._express.all(
        /^\/api\/.*/,
        (
          req: http.IncomingMessage,
          res: http.ServerResponse<http.IncomingMessage>,
        ) => {
          if (this._cfg.remove_api_string_from_url) req.url = req.url.substr(4);

          //console.log(`Proxing request: ${orgURL} -> ${this._cfg.api_url}${req.url}`);
          this._proxy.web(req, res);
        },
      );

      // Proxy socket.io calls.
      // proxy HTTP GET / POST
      this._express.get(
        /^\/socket\.io\/.*/,
        (
          req: http.IncomingMessage,
          res: http.ServerResponse<http.IncomingMessage>,
        ) => {
          //console.log("Proxying GET request", req.url);
          this._proxy.web(req, res, { target: this._cfg.api_url });
        },
      );
      this._express.post(
        /^\/socket\.io\/.*/,
        (
          req: http.IncomingMessage,
          res: http.ServerResponse<http.IncomingMessage>,
        ) => {
          //console.log("Proxying POST request", req.url);
          this._proxy.web(req, res, { target: this._cfg.api_url });
        },
      );

      // Proxy websockets
      // ATENTION: Very important, the event must be over the server object, NOT over the express handler function.
      this._server.on('upgrade', (req, socket, head) => {
        //console.log(`Proxying upgrade request: ${req.url}`);
        this._proxy.ws(req, socket, head);
      });

      // Set origin header if not exists.
      this._proxy.on('proxyReq', (proxyReq: ClientRequest, req: Request) => {
        // Log every proxied request.
        this.log.http(
          `${req.ip}|HTTP/${req.httpVersion}|${req.method.toUpperCase()}|${req.originalUrl}`,
        );

        if (!proxyReq.getHeader('origin')) {
          if (proxyReq.getHeader('referer')) {
            const referer: string = proxyReq.getHeader('referer').toString();
            if (referer) {
              const origin = referer.substr(
                0,
                referer.indexOf('/', referer.indexOf('://') + 3),
              );
              proxyReq.setHeader('origin', origin);
            }
          } else proxyReq.setHeader('origin', '');
        }
      });

      this._proxy.on('error', (err, req, res) => {
        /* If we stop fwcloud-api in the middle of an API request, the proxy will receive two errors:
            - ECONNRESET: (socket hang up) for the API request interrupted.
            - EPIPE: (This socket has been ended by the other party) for the websocket.
          In the second one, the method res.writeHead() is undefined and triggers the execution end of
          the fwcloud-websrv process. For this reason we must verify that this method exists before
          invoking it.
        */
        if ((res as http.ServerResponse).writeHead)
          (res as http.ServerResponse).writeHead(500, {
            'Content-Type': 'text/plain',
          });
        res.end(`ERROR: Proxing request: ${req.url}`);
        this.log.error(`Proxing request: ${req.url} - `, err);
      });

      // Document root for the web server static files.
      this._express.use('/manual', express.static(this._cfg.docroot_ui_doc));
      this._express.use(express.static(this._cfg.docroot_ui));

      // Redirect any unhandled route to Angular's index.html
      this._express.use(
        (req: any, res: { sendFile: (arg0: string) => void }) => {
          res.sendFile(path.join(this._cfg.docroot_ui, 'index.html'));
        },
      );
    } catch (err: any) {
      const msg = `Application can not start: ${(err as Error).message}`;
      this.log.error(msg);
      this.log.error((err as Error).stack);
      console.error(msg);
      console.error((err as Error).stack);
      // This pause before process exit is necessary for error logs to appear in log file.
      await new Promise(() => {
        setTimeout(() => process.exit(1), 100);
      });
    }
  }

  public async start(): Promise<any> {
    try {
      this._server = this._cfg.https
        ? this.startHttpsServer()
        : this.startHttpServer();
      await this.proxySetup();
      this.bootstrapEvents();
    } catch (err: any) {
      const msg = `Starting FWCloud WEB server: ${(err as Error).message}`;
      this.log.error(msg);
      console.error(msg);
      // This pause before process exit is necessary for error logs to appear in log file.
      await new Promise(() => {
        setTimeout(() => process.exit(1), 100);
      });
    }

    return this;
  }

  private startHttpsServer(): https.Server {
    const tlsOptions = {
      key: fs.readFileSync(this._cfg.key).toString(),
      cert: fs.readFileSync(this._cfg.cert).toString(),
      ca: this._cfg.ca_bundle
        ? fs.readFileSync(this._cfg.ca_bundle).toString()
        : null,
    };

    return https.createServer(
      tlsOptions,
      this._express as unknown as http.RequestListener,
    );
  }

  private startHttpServer(): http.Server {
    return http.createServer(this._express as unknown as http.RequestListener);
  }

  private bootstrapEvents() {
    this._server.listen(this._cfg.port, this._cfg.host);

    this._server.on('error', (error: Error) => {
      throw error;
    });

    this._server.on('listening', () => {
      this.log.info(`Listening on ${this.getFullURL()}`);
      // If the service is started successfully then store the PID in the file.
      fs.writeFileSync('.pid', `${process.pid}`);
    });
  }

  protected getFullURL(): string {
    return (
      (this._cfg.https ? 'https' : 'http') +
      '://' +
      this._cfg.host +
      ':' +
      this._cfg.port
    );
  }
}
