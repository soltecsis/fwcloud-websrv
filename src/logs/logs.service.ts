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

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as winston from 'winston';

@Injectable()
export class LogsService {
  private _logger: winston.Logger;
  private _http_logger: winston.Logger;

  constructor() {
    // Make sure logs directory exists.
    if (!fs.existsSync('logs')){
      fs.mkdirSync('logs');
    }

    this._logger = winston.createLogger({
      level: 'debug',
      levels: winston.config.npm.levels,
      format: winston.format.combine (
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.printf(info => `${info.timestamp}|${info.level.toUpperCase()}|${info.message}`)
      ),
      defaultMeta: { service: 'user-service' },
      transports: [
        new winston.transports.File({ filename: 'logs/app.log', maxsize: 4194304, maxFiles: 7, tailable: true }),
      ],
    });

    this._http_logger = winston.createLogger({
      level: 'entry',
      levels: {entry: 0},
      format: winston.format.combine (
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.printf(info => `${info.timestamp}|${info.message}`)
      ),
      defaultMeta: { service: 'user-service' },
      transports: [
        new winston.transports.File({ filename: 'logs/http.log', maxsize: 4194304, maxFiles: 7, tailable: true }),
      ],
    });
  }

  http(log: string):void {
    this._http_logger.log('entry',log);
  }

  error(log: string, meta?: any):void {
    this._logger.error(log, meta);
  }

  info(log: string, meta?: any):void {
    this._logger.info(log, meta);
  }
}
