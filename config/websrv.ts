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

import { registerAs } from '@nestjs/config';

export default registerAs('websrv', () => ({
  host: process.env.LISTEN_HOST || '0.0.0.0',
  port: process.env.LISTEN_PORT || 3030,

  // Web server document root path.
  docroot: process.env.DOCUMENT_ROOT || '/opt/fwcloud/ui/dist',

  // API access URL.
  api_url: process.env.FWC_API_URL || 'https://localhost:3131',
  
  // Remove the heading string /api before proxying the request to the API server.
  remove_api_string_from_url: process.env.REMOVE_API_STRING_FROM_URL || true,

  // Enable HTTPS protocol for the web server.
  https: process.env.HTTPS_ENABLED === 'false' ? false : true,

  // Path to certificate file for the web server.
  cert: process.env.HTTPS_CERT || './config/tls/fwcloud-websrv.crt',

  // Path to key file for the web server.
  key: process.env.HTTPS_KEY || './config/tls/fwcloud-websrv.key',

  // Path to CA bundle file for the web server.
  ca_bundle: process.env.HTTPS_CA_BUNDLE || '',

  // timeout (in millis) for outgoing proxy requests
  proxyTimeout: process.env.PROXY_TIMEOUT || 600000
}));
