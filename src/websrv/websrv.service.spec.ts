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

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LogsService } from '../logs/logs.service';
import { WebsrvService, WebsrvServiceConfig } from './websrv.service';

describe('WebsrvService', () => {
  let service: WebsrvService;
  const config: WebsrvServiceConfig = {
    host: '127.0.0.1',
    port: 3000,
    docroot_ui: '.',
    docroot_ui_doc: '.',
    api_url: 'http://127.0.0.1:3001',
    remove_api_string_from_url: false,
    https: false,
    cert: '',
    key: '',
    ca_bundle: '',
    proxyTimeout: 1000,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebsrvService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(config),
          },
        },
        {
          provide: LogsService,
          useValue: {
            error: jest.fn(),
            http: jest.fn(),
            info: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<WebsrvService>(WebsrvService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
