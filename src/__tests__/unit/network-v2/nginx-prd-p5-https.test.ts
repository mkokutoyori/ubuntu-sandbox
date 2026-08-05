/**
 * docs/PRD-Nginx.md §P5 — HTTPS.
 *
 * The PRD declared this phase blocked and named the blocker precisely:
 * there was no path by which a certificate could reach the VFS under
 * Linux, so nginx would have read a file no learner could produce. It
 * explicitly REFUSED the shortcut ("let a test drop a certificate in") for
 * that reason, and chose to wait for `openssl`.
 *
 * `openssl` exists now, so this suite does what the PRD demanded: the
 * certificate is produced BY THE MACHINE, with the same command a learner
 * types, and nginx reads what that command wrote. No fixture writes a PEM
 * by hand anywhere here — that is the whole point of the phase, and a test
 * that planted one would prove nothing about the lab being feasible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'TLS'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

/** The lab's own steps, in the order a learner performs them. */
async function makeCertificate(srv: LinuxServer): Promise<void> {
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/lab.key '
    + '-out /etc/ssl/certs/lab.crt -days 365 -nodes -subj "/CN=lab.local"');
}

async function writeSite(srv: LinuxServer, lines: string): Promise<void> {
  await srv.executeCommand(
    `sh -c 'printf "${lines}" > /etc/nginx/sites-available/default'`);
}

const HTTPS_SITE =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/lab.crt;\\n'
  + '  ssl_certificate_key /etc/ssl/private/lab.key;\\n}\\n';

describe('§P5 — the certificate comes from the machine', () => {
  it('openssl writes both files where nginx will look for them', async () => {
    const srv = machine();
    await makeCertificate(srv);

    expect(await srv.executeCommand('cat /etc/ssl/certs/lab.crt')).toContain('BEGIN CERTIFICATE');
    expect(await srv.executeCommand('cat /etc/ssl/private/lab.key')).toContain('PRIVATE KEY');
    expect(await srv.executeCommand('openssl x509 -in /etc/ssl/certs/lab.crt -noout -subject'))
      .toContain('CN = lab.local');
  });

  /**
   * THE INVARIANT THIS PHASE FOUND, pinned where an openssl edit will
   * meet it.
   *
   * `req -x509 -keyout k -out c` wrote one private key to disk and built
   * the certificate from a DIFFERENT keypair generated inside
   * `generateSelfSignedCertificate`. Every command that reads one file
   * without the other was happy — `x509 -noout -subject` printed the
   * subject, `verify` self-verified — so nothing caught it until a TLS
   * server presented the pair and the handshake failed.
   */
  it('the certificate certifies the key that was written beside it', async () => {
    const srv = machine();
    await makeCertificate(srv);

    // The canonical check every admin runs to pair a key with its
    // certificate. It only means anything if both sides print the same
    // quantity, which is why `rsa -modulus` had to stop printing the
    // private material.
    const fromCert = await srv.executeCommand(
      'openssl x509 -in /etc/ssl/certs/lab.crt -noout -modulus');
    const fromKey = await srv.executeCommand(
      'openssl rsa -in /etc/ssl/private/lab.key -noout -modulus');

    expect(fromCert.trim()).toMatch(/^Modulus=\S+$/);
    expect(fromKey.trim()).toBe(fromCert.trim());
  });

  it('nginx -t accepts ssl_certificate instead of refusing it', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);

    // Before §P5 these two directives sat in `KNOWN_UNSUPPORTED` and this
    // configuration was refused outright.
    const verdict = await srv.executeCommand('nginx -t');
    expect(verdict).toContain('test is successful');
    expect(verdict).not.toContain('[emerg]');
  });
});

describe('§P5 — the port is really served over TLS', () => {
  it('systemctl start opens 443 and a real handshake carries the page', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);

    await srv.executeCommand('systemctl start nginx');

    expect(await srv.executeCommand('ss -ltn')).toMatch(/:443\s/);
    // `-k` because the certificate is self-signed: the client is right to
    // object, and saying so is the lesson rather than a workaround.
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1/'))
      .toContain('Welcome to nginx!');
  });

  it('the listener is named, so ss -ltnp does not show an ownerless 443', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);
    await srv.executeCommand('systemctl start nginx');

    const owned = (await srv.executeCommand('ss -ltnp'))
      .split('\n').filter((l) => /:443\s/.test(l));
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.join('\n')).toContain('nginx');
  });

  it('a self-signed certificate is REFUSED without -k, and says so', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);
    await srv.executeCommand('systemctl start nginx');

    const out = await srv.executeCommand('curl -sS https://127.0.0.1/');

    // The whole point of a lab certificate: the client does not trust it.
    expect(out).not.toContain('Welcome to nginx!');
    expect(out).toMatch(/certificate|SSL|self.signed/i);
  });

  it('80 and 443 can be served at once, each with its own transport', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv,
      'server {\\n  listen 80 default_server;\\n  server_name _;\\n  root /var/www/html;\\n'
      + '  index index.nginx-debian.html;\\n}\\n'
      + 'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
      + '  index index.nginx-debian.html;\\n'
      + '  ssl_certificate /etc/ssl/certs/lab.crt;\\n'
      + '  ssl_certificate_key /etc/ssl/private/lab.key;\\n}\\n');

    await srv.executeCommand('systemctl start nginx');

    const ports = await srv.executeCommand('ss -ltn');
    expect(ports).toMatch(/:80\s/);
    expect(ports).toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS http://127.0.0.1/')).toContain('Welcome to nginx!');
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1/')).toContain('Welcome to nginx!');
  });
});

describe('§P5 — a missing certificate never degrades to cleartext', () => {
  it('a deleted certificate keeps 443 SHUT rather than serving in the clear', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);
    await srv.executeCommand('rm /etc/ssl/certs/lab.crt');

    await srv.executeCommand('systemctl start nginx');

    // The worst possible answer would be a plain HTTP server on 443. The
    // port stays closed instead.
    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    expect(await srv.executeCommand('curl -sS -k https://127.0.0.1/')).not.toContain('Welcome');
  });

  it('the refusal names the file, in nginx\'s own words, in error.log', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);
    await srv.executeCommand('rm /etc/ssl/private/lab.key');
    await srv.executeCommand('systemctl start nginx');

    const log = await srv.executeCommand('cat /var/log/nginx/error.log');
    expect(log).toContain('/etc/ssl/private/lab.key');
    expect(log).toContain('BIO_new_file() failed');
  });

  it('listen 443 ssl with no ssl_certificate at all is refused too', async () => {
    const srv = machine();
    await writeSite(srv,
      'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n}\\n');

    await srv.executeCommand('systemctl start nginx');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    expect(await srv.executeCommand('cat /var/log/nginx/error.log'))
      .toContain('no "ssl_certificate" is defined');
  });

  it('a file that is not a certificate is refused, not half-loaded', async () => {
    const srv = machine();
    await makeCertificate(srv);
    await writeSite(srv, HTTPS_SITE);
    await srv.executeCommand(`sh -c 'printf "not a certificate\\n" > /etc/ssl/certs/lab.crt'`);

    await srv.executeCommand('systemctl start nginx');

    expect(await srv.executeCommand('ss -ltn')).not.toMatch(/:443\s/);
    expect(await srv.executeCommand('cat /var/log/nginx/error.log')).toContain('PEM routines');
  });
});
