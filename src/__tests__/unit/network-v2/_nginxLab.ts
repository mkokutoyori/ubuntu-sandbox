import type { LinuxServer } from '@/network/devices/LinuxServer';
import { machine, sh } from './_httpsLab';

export const ROWS = 200;

export async function site(srv: LinuxServer, body: string): Promise<void> {
  const text = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\$/g, '\\$').replace(/'/g, `'\\''`);
  await sh(srv, `sh -c 'printf "${text}" > /etc/nginx/sites-available/default'`);
}

export const SERVER = (extra = '') => `server {
  listen 80 default_server;
  server_name _;
  root /var/www/html;
  index index.nginx-debian.html;
  access_log /var/log/nginx/access.log;
${extra}}
`;

export async function up(extra = '', http = ''): Promise<LinuxServer> {
  const srv = machine();
  await sh(srv, `sh -c 'seq 1 ${ROWS} | sed "s/.*/<p>row &<\\/p>/" > /var/www/html/big.html'`);
  await sh(srv, `sh -c 'seq 1 ${ROWS} | sed "s/.*/p { row: & }/" > /var/www/html/site.css'`);
  await sh(srv, `sh -c 'printf "{\\"a\\":1}" > /var/www/html/tiny.json'`);
  await sh(srv, `sh -c 'printf "hi" > /var/www/html/tiny.html'`);
  await site(srv, `${http}${SERVER(extra)}`);
  const test = await sh(srv, 'nginx -t');
  if (!test.includes('successful')) throw new Error(test);
  await sh(srv, 'systemctl start nginx');
  return srv;
}
