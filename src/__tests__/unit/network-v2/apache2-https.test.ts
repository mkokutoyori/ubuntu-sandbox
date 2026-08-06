/**
 * apache2 over TLS — the twin of `docs/PRD-Nginx.md` §P5.
 *
 * This was found while shipping §P5 for nginx rather than looked for: the
 * Apache service built an `Http1ServerSession` for EVERY port, so a
 * `<VirtualHost *:443>` was served as plain HTTP on 443. Nothing failed,
 * nothing warned — the machine simply answered cleartext on the port whose
 * entire meaning is that it is not, which is worse than refusing.
 *
 * The rule both servers now share: a virtual host that asked for TLS and
 * cannot have it keeps its port SHUT and says which file is missing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'AT'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

/** The learner's own steps, in order. */
async function makeCertificate(srv: LinuxServer): Promise<void> {
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:512 -keyout /etc/ssl/private/lab.key '
    + '-out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=lab.local"');
}

async function writeSslSite(srv: LinuxServer, cert: string, key: string): Promise<void> {
  await srv.executeCommand(
    `sh -c 'printf "<VirtualHost *:443>\\n\\tDocumentRoot /var/www/html\\n`
    + `\\tSSLEngine on\\n\\tSSLCertificateFile ${cert}\\n`
    + `\\tSSLCertificateKeyFile ${key}\\n</VirtualHost>\\n" `
    + `> /etc/apache2/sites-available/lab-ssl.conf'`);
  await srv.executeCommand(
    'ln -s ../sites-available/lab-ssl.conf /etc/apache2/sites-enabled/lab-ssl.conf');
}

describe('apache2 over TLS — Debian ships default-ssl disabled', () => {
  it('default-ssl.conf is available and not enabled, as on a real machine', async () => {
    const srv = machine();

    expect(await srv.executeCommand('ls /etc/apache2/sites-available'))
      .toContain('default-ssl.conf');
    expect(await srv.executeCommand('ls /etc/apache2/sites-enabled'))
      .not.toContain('default-ssl.conf');
  });

  it('enabling it as shipped refuses, because the snakeoil certificate is absent', async () => {
    const srv = machine();
    // `a2ensite default-ssl` is only an `ln -s`.
    await srv.executeCommand(
      'ln -s ../sites-available/default-ssl.conf /etc/apache2/sites-enabled/default-ssl.conf');

    await srv.executeCommand('systemctl start apache2');

    // 80 still works; only the TLS port is refused.
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    expect(await srv.executeCommand('cat /var/log/apache2/error.log'))
      .toContain('/etc/ssl/certs/ssl-cert-snakeoil.pem');
  });
});

describe('apache2 over TLS — a certificate the machine made', () => {
  it('a real handshake carries the default page on 443', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/lab.key');

    await srv.executeCommand('systemctl start apache2');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1:443/'))
      .toContain('It works!');
  });

  it('80 and 443 are served at once, each with its own transport', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/lab.key');
    await srv.executeCommand('systemctl start apache2');

    const ports = await srv.executeCommand('ss -ltn');
    expect(ports).toMatch(/:80\s/);
    expect(ports).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('It works!');
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1:443/')).toContain('It works!');
  });

  it('without -k the self-signed certificate is refused', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/lab.key');
    await srv.executeCommand('systemctl start apache2');

    const out = await srv.executeCommand('curl -sS https://127.0.0.1:443/');
    expect(out).not.toContain('It works!');
    expect(out).toMatch(/certificate|SSL|self.signed/i);
  });

  it('apachectl -S shows the TLS vhost like any other', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/lab.key');

    expect(await srv.executeCommand('apachectl -S')).toMatch(/\*:443/);
  });
});

describe('apache2 over TLS — never cleartext on 443', () => {
  it('a deleted certificate keeps 443 shut instead of serving in the clear', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/lab.key');
    await srv.executeCommand('rm /etc/ssl/certs/lab.crt');

    await srv.executeCommand('systemctl start apache2');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    // The defect this file exists for: before the fix, THIS returned the
    // page over plain HTTP on 443.
    expect(await srv.executeCommand('curl -sS http://127.0.0.1:443/')).not.toContain('It works!');
  });

  it('the refusal names the missing file with Apache\'s own AH code', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/missing.key');

    await srv.executeCommand('systemctl start apache2');

    const log = await srv.executeCommand('cat /var/log/apache2/error.log');
    expect(log).toContain('AH00526');
    expect(log).toContain('/etc/ssl/private/missing.key');
  });

  it('SSLEngine on with no certificate at all is refused with AH02572', async () => {
    const srv = machine();
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:443>\\n\\tDocumentRoot /var/www/html\\n`
      + `\\tSSLEngine on\\n</VirtualHost>\\n" > /etc/apache2/sites-available/bare.conf'`);
    await srv.executeCommand(
      'ln -s ../sites-available/bare.conf /etc/apache2/sites-enabled/bare.conf');

    await srv.executeCommand('systemctl start apache2');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    expect(await srv.executeCommand('cat /var/log/apache2/error.log')).toContain('AH02572');
  });

  it('a file that is not a certificate is refused, not half-loaded', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSslSite(srv, '/etc/ssl/certs/lab.crt', '/etc/ssl/private/lab.key');
    await srv.executeCommand(`sh -c 'printf "junk\\n" > /etc/ssl/certs/lab.crt'`);

    await srv.executeCommand('systemctl start apache2');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    expect(await srv.executeCommand('cat /var/log/apache2/error.log')).toContain('AH02561');
  });

  it('a vhost WITHOUT SSLEngine on 443 stays plain HTTP, which is what it asked for', async () => {
    const srv = machine();
    await srv.executeCommand(
      `sh -c 'printf "<VirtualHost *:443>\\n\\tDocumentRoot /var/www/html\\n</VirtualHost>\\n" `
      + `> /etc/apache2/sites-available/plain443.conf'`);
    await srv.executeCommand(
      'ln -s ../sites-available/plain443.conf /etc/apache2/sites-enabled/plain443.conf');

    await srv.executeCommand('systemctl start apache2');

    // Refusing this one would be over-reach: the operator asked for HTTP
    // on an unusual port, and real Apache serves it.
    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS http://127.0.0.1:443/')).toContain('It works!');
  });
});
