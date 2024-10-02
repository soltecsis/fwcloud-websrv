/*
    Copyright 2020 SOLTECSIS SOLUCIONES TECNOLOGICAS, SLU
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

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LogsService } from './logs/logs.service';
import { WebsrvService } from './websrv/websrv.service';
import * as fs from 'fs';
import { HttpServer, INestApplication } from '@nestjs/common';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(AppModule);
  const log: LogsService = app.get<LogsService>(LogsService);

  log.info(`------- Starting application -------`);
  log.info(
    `FWCloud Websrv v${(JSON.parse(fs.readFileSync('package.json').toString()) as { version: string }).version} (PID=${process.pid})`,
  );

  // We are not going to use the http server created by NestFactory.
  const httpServer = app.getHttpServer() as HttpServer;
  httpServer.close();

  const websrv: WebsrvService = app.get<WebsrvService>(WebsrvService);
  void websrv.start();

  function signalHandler(signal: 'SIGINT' | 'SIGTERM') {
    log.info(`Received signal: ${signal}`);
    fs.unlink('.pid', () => {
      log.info(`------- Application stopped --------`);
      void app.close();
      // This pause before process exit is necessary for logs to appear in log file.
      setTimeout(() => process.exit(0), 100);
    });
  }
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
}
void bootstrap();
