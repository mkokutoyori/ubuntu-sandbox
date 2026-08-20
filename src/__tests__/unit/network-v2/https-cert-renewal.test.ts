/**
 * Renewing a certificate and reloading — the one TLS operation everybody
 * performs, and the one certbot automates.
 *
 * Found by rereading `docs/PRD-Nginx.md` §P5 rather than by a failing
 * test: `reload()` only ever OPENED ports that were not open yet, so a
 * port already serving kept the certificate it started with. Replacing
 * the PEM and reloading left the server presenting the OLD one — port up,
 * configuration right, and the machine showing something the operator
 * believes they replaced.
 *
 * The failure case is the half worth arguing about, and it is asserted
 * here: a port whose NEW material cannot be read is left alone rather than
 * closed. Real nginx aborts the reload and its old workers keep serving;
 * going dark on a botched renewal would turn a recoverable mistake into an
 * outage, which is a worse answer than the bug.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'RN'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

async function issueCertificate(srv: LinuxServer, cn: string): Promise<void> {
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:512 -keyout /etc/ssl/private/lab.key '
    + `-out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=${cn}"`);
}

/**
 * The subject of the certificate the server PRESENTS on the wire.
 *
 * Asserting only that `curl -k` succeeds proves nothing about a renewal:
 * the old pair is internally consistent, so a server that kept it
 * completes the handshake just as happily. `-v` reports the peer
 * certificate, which is the only thing that distinguishes the two.
 */
async function presentedSubject(srv: LinuxServer, port = ''): Promise<string> {
  const trace = await srv.executeCommand(`curl -sS -v -k https://127.0.0.1${port}/`);
  return /\*\s+subject:\s*(.+)/.exec(trace)?.[1]?.trim() ?? '<none>';
}

const NGINX_SSL_SITE =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/lab.crt;\\n'
  + '  ssl_certificate_key /etc/ssl/private/lab.key;\\n}\\n';

async function writeNginxSite(srv: LinuxServer): Promise<void> {
  await srv.executeCommand(
    `sh -c 'printf "${NGINX_SSL_SITE}" > /etc/nginx/sites-available/default'`);
}

async function writeApacheSslSite(srv: LinuxServer): Promise<void> {
  // `mod_ssl` est livré ÉTEINT par Debian, et Apache refuse `SSLEngine`
  // tant qu'il l'est — `Invalid command`, exactement comme un vrai
  // serveur. Ces cas passaient parce que le simulateur ne jugeait
  // aucune directive : ils décrivaient un TLS qui marche sans son
  // module (voir `docs/PRD-Nginx.md` §9.9).
  await srv.executeCommand('a2enmod ssl');
  await srv.executeCommand(
    `sh -c 'printf "<VirtualHost *:443>\\n\\tDocumentRoot /var/www/html\\n`
    + `\\tSSLEngine on\\n\\tSSLCertificateFile /etc/ssl/certs/lab.crt\\n`
    + `\\tSSLCertificateKeyFile /etc/ssl/private/lab.key\\n</VirtualHost>\\n" `
    + `> /etc/apache2/sites-available/lab-ssl.conf'`);
  await srv.executeCommand(
    'ln -s ../sites-available/lab-ssl.conf /etc/apache2/sites-enabled/lab-ssl.conf');
}

describe('nginx — reload picks up a renewed certificate', () => {
  it('the renewed certificate really replaces the old one', async () => {
    const srv = machine();
    await issueCertificate(srv, 'old.lab');
    await writeNginxSite(srv);
    await srv.executeCommand('systemctl start nginx');
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1/'))
      .toContain('Welcome to nginx!');

    // Renew: same paths, different certificate.
    expect(await presentedSubject(srv)).toContain('old.lab');

    await issueCertificate(srv, 'new.lab');
    await srv.executeCommand('systemctl reload nginx');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await presentedSubject(srv)).toContain('new.lab');
  });

  /**
   * `nginx -s reload` goes STRAIGHT to the server: unlike
   * `systemctl reload`, nothing re-binds the sockets behind it, so the
   * running session would keep the certificate it started with. That is
   * the path `reopenRenewedTlsPorts` exists for — measured, after finding
   * that the systemctl path already picked a renewal up on its own
   * through `resyncServicePorts`.
   */
  it('`nginx -s reload` picks up the renewal too, with no service manager behind it', async () => {
    const srv = machine('SIG');
    await issueCertificate(srv, 'old.lab');
    await writeNginxSite(srv);
    await srv.executeCommand('systemctl start nginx');

    expect(await presentedSubject(srv)).toContain('old.lab');

    await issueCertificate(srv, 'new.lab');
    await srv.executeCommand('nginx -s reload');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await presentedSubject(srv)).toContain('new.lab');
  });

  it('a broken renewal leaves the port serving rather than going dark', async () => {
    const srv = machine();
    await issueCertificate(srv, 'good.lab');
    await writeNginxSite(srv);
    await srv.executeCommand('systemctl start nginx');

    // The classic botched renewal: the file is replaced by something that
    // is not a certificate.
    await srv.executeCommand(`sh -c 'printf "junk\\n" > /etc/ssl/certs/lab.crt'`);
    await srv.executeCommand('systemctl reload nginx');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1/'))
      .toContain('Welcome to nginx!');
  });

  it('an unchanged certificate is not swapped for itself', async () => {
    const srv = machine();
    await issueCertificate(srv, 'stable.lab');
    await writeNginxSite(srv);
    await srv.executeCommand('systemctl start nginx');

    await srv.executeCommand('systemctl reload nginx');
    await srv.executeCommand('systemctl reload nginx');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1/'))
      .toContain('Welcome to nginx!');
  });
});

describe('the configuration test reads the certificates', () => {
  /**
   * This is what makes the "botched renewal keeps serving" case above
   * possible, and it is a fidelity fix in its own right: the real
   * `nginx -t` OPENS `ssl_certificate` and fails when it cannot be read.
   * Ours reported `test is successful` on an unreadable certificate — a
   * verdict nothing backed, and the very check an operator runs BEFORE
   * reloading precisely to avoid taking the site down.
   */
  it('nginx -t fails on an unreadable certificate instead of passing', async () => {
    const srv = machine('CT');
    await issueCertificate(srv, 'ok.lab');
    await writeNginxSite(srv);
    expect(await srv.executeCommand('nginx -t')).toContain('test is successful');

    await srv.executeCommand(`sh -c 'printf "junk\\n" > /etc/ssl/certs/lab.crt'`);

    const verdict = await srv.executeCommand('nginx -t');
    expect(verdict).not.toContain('test is successful');
    expect(verdict).toContain('/etc/ssl/certs/lab.crt');
  });

  it('apachectl configtest fails on a missing certificate instead of passing', async () => {
    const srv = machine('CT2');
    await issueCertificate(srv, 'ok.lab');
    await writeApacheSslSite(srv);
    expect(await srv.executeCommand('apachectl configtest')).toContain('Syntax OK');

    await srv.executeCommand('rm /etc/ssl/private/lab.key');

    const verdict = await srv.executeCommand('apachectl configtest');
    expect(verdict).not.toContain('Syntax OK');
    expect(verdict).toContain('/etc/ssl/private/lab.key');
  });
});

describe('apache2 — graceful picks up a renewed certificate', () => {
  it('the renewed certificate really replaces the old one', async () => {
    const srv = machine('RA');
    await issueCertificate(srv, 'old.lab');
    await writeApacheSslSite(srv);
    await srv.executeCommand('systemctl start apache2');
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1:443/'))
      .toContain('It works!');

    expect(await presentedSubject(srv, ':443')).toContain('old.lab');

    await issueCertificate(srv, 'new.lab');
    await srv.executeCommand('apachectl graceful');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await presentedSubject(srv, ':443')).toContain('new.lab');
  });

  it('a broken renewal leaves the port serving rather than going dark', async () => {
    const srv = machine('RA2');
    await issueCertificate(srv, 'good.lab');
    await writeApacheSslSite(srv);
    await srv.executeCommand('systemctl start apache2');

    await srv.executeCommand(`sh -c 'printf "junk\\n" > /etc/ssl/certs/lab.crt'`);
    await srv.executeCommand('apachectl graceful');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1:443/'))
      .toContain('It works!');
  });
});
