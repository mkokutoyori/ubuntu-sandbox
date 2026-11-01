import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { configureLinuxHost } from './internet';
import { PLAN, PUBLIC_DOMAIN } from './plan';
import { NGINX_SITE_CONF, SITE_ROOT, TLS_DIRECTORY, WEB_FILES } from './site';

const SUBJECT_ALT_NAMES = ['', 'www.', 'ebanking.', 'agences.', 'api.']
  .map((label) => `DNS:${label}${PUBLIC_DOMAIN}`)
  .join(',');

export async function configureWebServer(bench: LabWorkbench, webBank: Equipment): Promise<void> {
  await configureLinuxHost(bench, webBank, PLAN.webBank, '127.0.0.53');
  await bench.shell(webBank, 'sudo apt install -y nginx');
  const directories = [...new Set(Object.keys(WEB_FILES).map((path) => path.slice(0, path.lastIndexOf('/'))))];
  await bench.shell(webBank, `sudo mkdir -p ${directories.map((directory) => `${SITE_ROOT}/${directory}`).join(' ')} ${TLS_DIRECTORY}`);
  for (const [path, content] of Object.entries(WEB_FILES)) {
    await bench.writeFile(webBank, `${SITE_ROOT}/${path}`, content);
  }
  await bench.shell(
    webBank,
    `sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout ${TLS_DIRECTORY}/banquehorizon.key -out ${TLS_DIRECTORY}/banquehorizon.crt -subj "/C=CM/O=Banque Horizon/CN=www.${PUBLIC_DOMAIN}" -addext "subjectAltName=${SUBJECT_ALT_NAMES}"`,
    `sudo chmod 600 ${TLS_DIRECTORY}/banquehorizon.key`,
  );
  await bench.writeFile(webBank, '/etc/nginx/sites-available/banquehorizon.conf', NGINX_SITE_CONF);
  await bench.shell(
    webBank,
    'sudo rm -f /etc/nginx/sites-enabled/default',
    'sudo ln -s /etc/nginx/sites-available/banquehorizon.conf /etc/nginx/sites-enabled/banquehorizon.conf',
    'sudo nginx -t',
    'sudo systemctl restart nginx',
  );
}
