/**
 * `curl -w '%{num_certs}'` rend le nombre de certificats que le serveur a presentes. Mesure de depart (TODO.md
 * [curl-writeout]) : la variable valait toujours 0. Releve contre le vrai curl 8.5.0 / OpenSSL 3.0.13 de la machine
 * de reference, sur un `openssl s_server -cert c.pem` a certificat auto-signe unique, sans --certinfo :
 *   curl -sk -o /dev/null -w '%{num_certs}' https://localhost:8443/  -> 1
 *   curl -s  -o /dev/null -w '%{num_certs}' https://localhost:8444/  -> 0 (sortie 60 : la verification echoue)
 * et 0 pour une connexion http. Corrige : le nombre vient de la chaine que la poignee de main a recue.
 *
 * Discrimine par `git stash` sur src/network : 2 des 4 cas tombent avant. TEMOINS : une connexion http et une
 * verification stricte qui echoue rendent 0 (valeur d'avant, partout).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const SITE = (cert: string, key: string): string =>
  'server {\\n  listen 443 ssl;\\n  listen 80;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + `  ssl_certificate ${cert};\\n  ssl_certificate_key ${key};\\n}\\n`;

async function lab(chained: boolean): Promise<LinuxServer> {
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
  if (chained) await srv.executeCommand('sh -c "cat /etc/ssl/certs/srv.crt /etc/ssl/certs/ca.crt > /etc/ssl/certs/chain.crt"');
  const site = SITE(chained ? '/etc/ssl/certs/chain.crt' : '/etc/ssl/certs/srv.crt', '/etc/ssl/private/srv.key');
  await srv.executeCommand(`sh -c 'printf "${site}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
  return srv;
}

const numCerts = async (srv: LinuxServer, url: string): Promise<string> =>
  String(await srv.executeCommand(`curl -sk -o /dev/null -w '%{num_certs}' ${url}`)).trim();

describe('num_certs', () => {
  it('TEMOIN — une connexion http rend 0', async () => {
    expect(await numCerts(await lab(false), 'http://127.0.0.1/')).toBe('0');
  });

  it('un serveur qui presente une seule feuille rend 1', async () => {
    expect(await numCerts(await lab(false), 'https://127.0.0.1/')).toBe('1');
  });

  it('un serveur qui presente la feuille puis son autorite rend 2', async () => {
    expect(await numCerts(await lab(true), 'https://127.0.0.1/')).toBe('2');
  });

  it('une verification stricte qui echoue (exit 60) ne releve aucun certificat', async () => {
    const srv = await lab(false);
    const out = String(await srv.executeCommand(`curl -s -o /dev/null -w '%{num_certs}' https://127.0.0.1/`)).trim();
    expect(out).toBe('0');
  });
});
