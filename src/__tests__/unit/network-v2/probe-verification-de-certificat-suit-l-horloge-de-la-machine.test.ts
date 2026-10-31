/**
 * Un certificat expire pour la machine qui le verifie, pas pour l'heure globale du simulateur. `curl --cacert`
 * (CurlTransfer) et `openssl s_client` (tlsPeerProbe) construisaient leur CertificateVerifier sans horloge, donc sur
 * `simulationNowMs()` : un poste dont on avait pose l'horloge (`date -s`) deux cents jours plus tard validait toujours un
 * certificat de quatre-vingt-dix jours. Et `OpenSsl.ts` fournissait `simulationNowMs()` comme horloge de la machine au
 * moteur openssl (`host.now`), si bien que `openssl x509 -req`, `-checkend` et `verify` ignoraient eux aussi `date -s` ;
 * l'authentification client d'`openssl s_server` lisait la meme heure globale.
 * Corrige : ces lecteurs prennent l'horloge de LEUR machine (`TcpStack.nowMs`, `simulatedDate()`), le port etroit que
 * Kerberos avait pris. Reste ouvert dans TODO.md [horloge] : DNSSEC, caches DNS, horodatages SSH, autres verificateurs.
 *
 * Discrimine par `git stash` sur src/network : 3 des 4 cas tombent avant (curl, s_client, certificat delivre par une
 * machine en avance). Le TEMOIN passe des deux cotes : a l'heure, curl valide le certificat.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const DAY = 24 * 3600 * 1000;

async function buildPki(srv: LinuxServer): Promise<void> {
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:1024 -keyout /etc/ssl/private/ca.key '
    + '-out /etc/ssl/certs/ca.crt -days 3650 -nodes -subj "/CN=Lab Root CA"');
  await srv.executeCommand('openssl genrsa -out /etc/ssl/private/srv.key 1024');
  await srv.executeCommand('openssl req -new -key /etc/ssl/private/srv.key -out /tmp/srv.csr -subj "/CN=127.0.0.1"');
  await srv.executeCommand(
    'openssl x509 -req -in /tmp/srv.csr -CA /etc/ssl/certs/ca.crt '
    + '-CAkey /etc/ssl/private/ca.key -CAcreateserial -out /etc/ssl/certs/srv.crt -days 90');
}

const HTTPS_SITE =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/srv.crt;\\n'
  + '  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n';

async function lab(): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', 'PKI');
  srv.powerOn();
  await buildPki(srv);
  await srv.executeCommand(`sh -c 'printf "${HTTPS_SITE}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
  return srv;
}

async function setClockAhead(srv: LinuxServer, days: number): Promise<void> {
  const epoch = Math.floor((srv.executor.simulatedDate().getTime() + days * DAY) / 1000);
  await srv.executeCommand(`date -s @${epoch}`);
}

describe('la verification d un certificat lit l horloge de la machine', () => {
  it('TEMOIN — a l heure, curl valide le certificat de 90 jours', async () => {
    const srv = await lab();
    const out = await srv.executeCommand('curl -sS --cacert /etc/ssl/certs/ca.crt https://127.0.0.1/');
    expect(out).toContain('Welcome to nginx!');
  });

  it('curl sur une machine 200 jours plus tard : le certificat a expire', async () => {
    const srv = await lab();
    await setClockAhead(srv, 200);
    const out = await srv.executeCommand('curl -sS --cacert /etc/ssl/certs/ca.crt https://127.0.0.1/');
    expect(out).toContain('curl: (60)');
    expect(out).toContain('expired');
  });

  it('openssl s_client sur une machine 200 jours plus tard : erreur de verification 10', async () => {
    const srv = await lab();
    await srv.executeCommand('cp /etc/ssl/certs/ca.crt /usr/local/share/ca-certificates/lab-ca.crt');
    await srv.executeCommand('update-ca-certificates');
    const onTime = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443 </dev/null');
    expect(onTime).toContain('Verify return code: 0 (ok)');
    await setClockAhead(srv, 200);
    const out = await srv.executeCommand('openssl s_client -connect 127.0.0.1:443 </dev/null');
    expect(out).toMatch(/certificate has expired|error=10|num=10/);
  });

  it('un certificat delivre par une machine en avance de 400 jours n est pas encore valide a l heure du poste', async () => {
    const srv = new LinuxServer('linux-server', 'PKI');
    srv.powerOn();
    await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
    await setClockAhead(srv, 400);
    await buildPki(srv);
    await srv.executeCommand('date -s @' + Math.floor((srv.executor.simulatedDate().getTime() - 400 * DAY) / 1000));
    const out = await srv.executeCommand(
      'openssl verify -CAfile /etc/ssl/certs/ca.crt /etc/ssl/certs/srv.crt');
    expect(out).toMatch(/not yet valid|error 9|num=9/);
  });
});
