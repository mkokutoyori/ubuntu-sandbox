/**
 * `curl -w '%{ssl_verify_result}'` rend le code X509 du verdict d'OpenSSL, y compris sous `-k` ou la verification
 * est menee et son resultat ignore. Mesure de depart : la variable valait toujours 0 (TODO.md [curl-writeout]). Releve contre le
 * vrai curl 8.5.0 / OpenSSL 3.0.13 de la machine de reference, sur un `openssl s_server` a certificat auto-signe :
 *   curl -sk  https://localhost:8443/  -> 18 (self signed certificate)
 *   curl -s   https://localhost:8443/  -> 18, sortie 60
 *   curl -s --cacert c.pem ...         -> 0
 * Corrige : la poignee de main rend le verdict du verificateur strict (meme sous -k) et la table de x509VerifyError le
 * convertit en numero. Les codes suivent l'horloge de la machine du client (certificat expire = 10).
 *
 * Discrimine par `git stash` sur src/network : 3 des 4 cas tombent avant. TEMOIN : le certificat approuve rend 0 (la
 * valeur d'avant etait 0 partout).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const DAY = 24 * 3600 * 1000;

const HTTPS_SITE = (cert: string, key: string): string =>
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + `  ssl_certificate ${cert};\\n  ssl_certificate_key ${key};\\n}\\n`;

async function lab(selfSigned = false): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'PKI');
  srv.powerOn();
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:1024 -keyout /etc/ssl/private/ca.key '
    + '-out /etc/ssl/certs/ca.crt -days 3650 -nodes -subj "/CN=Lab Root CA"');
  await srv.executeCommand('openssl genrsa -out /etc/ssl/private/srv.key 1024');
  await srv.executeCommand('openssl req -new -key /etc/ssl/private/srv.key -out /tmp/srv.csr -subj "/CN=127.0.0.1"');
  await srv.executeCommand(
    'openssl x509 -req -in /tmp/srv.csr -CA /etc/ssl/certs/ca.crt '
    + '-CAkey /etc/ssl/private/ca.key -CAcreateserial -out /etc/ssl/certs/srv.crt -days 90');
  const site = selfSigned
    ? HTTPS_SITE('/etc/ssl/certs/ca.crt', '/etc/ssl/private/ca.key')
    : HTTPS_SITE('/etc/ssl/certs/srv.crt', '/etc/ssl/private/srv.key');
  await srv.executeCommand(`sh -c 'printf "${site}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
  return srv;
}

const verifyResult = async (srv: LinuxServer, flags: string): Promise<string> =>
  String(await srv.executeCommand(`curl -s ${flags} -o /dev/null -w '%{ssl_verify_result}' https://127.0.0.1/`)).trim();

describe('ssl_verify_result', () => {
  it('TEMOIN — un certificat approuve rend 0', async () => {
    expect(await verifyResult(await lab(), '--cacert /etc/ssl/certs/ca.crt')).toBe('0');
  });

  it('un certificat signe par une autorite inconnue rend 20, avec ou sans -k', async () => {
    const srv = await lab();
    expect(await verifyResult(srv, '')).toBe('20');
    expect(await verifyResult(srv, '-k')).toBe('20');
  });

  it('un certificat auto-signe rend 18, avec ou sans -k', async () => {
    const srv = await lab(true);
    expect(await verifyResult(srv, '')).toBe('18');
    expect(await verifyResult(srv, '-k')).toBe('18');
  });

  it('un certificat expire pour l horloge du client rend 10', async () => {
    const srv = await lab();
    const epoch = Math.floor((srv.getSystemClockMs() + 200 * DAY) / 1000);
    await srv.executeCommand(`date -s @${epoch}`);
    expect(await verifyResult(srv, '--cacert /etc/ssl/certs/ca.crt')).toBe('10');
  });
});
