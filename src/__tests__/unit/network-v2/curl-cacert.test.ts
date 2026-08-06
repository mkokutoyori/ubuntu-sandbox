/**
 * `curl --cacert` — the first thing in this simulator that VERIFIES a
 * certificate instead of merely negotiating TLS with one.
 *
 * Until this option existed, every HTTPS lab reached its server with `-k`,
 * and `-k` means "do not check". So a certificate could be malformed in
 * ways nothing here would ever notice: the handshake succeeded because the
 * two ends agreed, not because the certificate was usable. Two defects were
 * sitting in exactly that blind spot and are pinned below, because both are
 * invisible without an anchor to check against:
 *
 *   - a SAN is stored the way openssl spells it on the command line
 *     (`DNS:lab.local`), and the comparison used the whole string, so a
 *     certificate with a SAN never matched the host it named;
 *   - the common-name fallback looked for a bare `CN=`, while this
 *     simulator's own `openssl req` renders RFC 4514's spaced form
 *     (`CN = lab.local`), so no certificate issued HERE could ever match by
 *     common name.
 *
 * Everything below is built by the machine, with the commands a learner
 * types. No fixture writes a PEM by hand: a planted certificate would prove
 * nothing about whether the lab is feasible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function machine(name = 'PKI'): LinuxServer {
  const srv = new LinuxServer('linux-server', name);
  srv.powerOn();
  return srv;
}

/** CA, then a key, then a CSR, then the signature. The real four steps. */
async function buildPki(srv: LinuxServer, serverName: string): Promise<void> {
  await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
  await srv.executeCommand(
    'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/ca.key '
    + '-out /etc/ssl/certs/ca.crt -days 365 -nodes -subj "/CN=Lab Root CA"');
  await srv.executeCommand('openssl genrsa -out /etc/ssl/private/srv.key 2048');
  await srv.executeCommand(
    `openssl req -new -key /etc/ssl/private/srv.key -out /tmp/srv.csr -subj "/CN=${serverName}"`);
  await srv.executeCommand(
    'openssl x509 -req -in /tmp/srv.csr -CA /etc/ssl/certs/ca.crt '
    + '-CAkey /etc/ssl/private/ca.key -CAcreateserial '
    + '-out /etc/ssl/certs/srv.crt -days 90');
}

const HTTPS_SITE =
  'server {\\n  listen 443 ssl;\\n  server_name _;\\n  root /var/www/html;\\n'
  + '  index index.nginx-debian.html;\\n'
  + '  ssl_certificate /etc/ssl/certs/srv.crt;\\n'
  + '  ssl_certificate_key /etc/ssl/private/srv.key;\\n}\\n';

async function serve(srv: LinuxServer): Promise<void> {
  await srv.executeCommand(
    `sh -c 'printf "${HTTPS_SITE}" > /etc/nginx/sites-available/default'`);
  await srv.executeCommand('systemctl start nginx');
}

async function lab(serverName = '127.0.0.1'): Promise<LinuxServer> {
  const srv = machine();
  await buildPki(srv, serverName);
  await serve(srv);
  return srv;
}

describe('the option is parsed as an option, not refused', () => {
  it('--cacert is no longer answered with "not implemented"', async () => {
    const srv = machine();
    const out = await srv.executeCommand('curl --cacert /etc/ssl/certs/ca.crt http://127.0.0.1/');
    expect(out).not.toContain('is not implemented in this simulator');
  });

  it('a bundle that does not exist stops before the handshake, with curl error 77', async () => {
    const srv = await lab();
    const out = await srv.executeCommand(
      'curl -sS --cacert /etc/ssl/certs/absent.crt https://127.0.0.1/');
    expect(out).toContain('curl: (77)');
    expect(out).toContain('/etc/ssl/certs/absent.crt');
  });

  it('a missing bundle is an error, not a silent fallback to the system store', async () => {
    const srv = await lab();
    const out = await srv.executeCommand(
      'curl -sS --cacert /etc/ssl/certs/absent.crt https://127.0.0.1/');
    expect(out).not.toContain('Welcome to nginx!');
  });
});

describe('what the anchor decides', () => {
  /**
   * The reference case: no anchor at all. It has to FAIL, otherwise the
   * success below would prove nothing — a lab where the server answers
   * whatever you pass is not verifying anything.
   */
  it('without --cacert the machine does not trust its own private root', async () => {
    const srv = await lab();
    const out = await srv.executeCommand('curl -sS https://127.0.0.1/');
    expect(out).not.toContain('Welcome to nginx!');
    expect(out).toContain('curl: (60)');
  });

  it('with the CA that signed it, the page is served without -k', async () => {
    const srv = await lab();
    const out = await srv.executeCommand(
      'curl -sS --cacert /etc/ssl/certs/ca.crt https://127.0.0.1/');
    expect(out).toContain('Welcome to nginx!');
  });

  /**
   * The wrong root is refused, so `--cacert` is not a decorated `-k`.
   *
   * What this case does NOT discriminate, said rather than implied: the
   * engine REPLACES the trust store instead of adding to it, and a Linux
   * machine's store is empty here, so replacing and merging would both
   * refuse this. The choice is stated at the call site and matters the day
   * a machine ships an anchor of its own.
   */
  it('another root, built the same way, is refused', async () => {
    const srv = await lab();
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /tmp/other.key '
      + '-out /tmp/other.crt -days 365 -nodes -subj "/CN=Other Root CA"');

    const out = await srv.executeCommand('curl -sS --cacert /tmp/other.crt https://127.0.0.1/');
    expect(out).not.toContain('Welcome to nginx!');
    expect(out).toContain('curl: (60)');
  });

  it('the name on the certificate has to be the name that was dialled', async () => {
    // Signed by the right CA, for the wrong host: the anchor is fine and
    // the identity is not, which is a different refusal from the one above.
    const srv = await lab('elsewhere.lab');
    const out = await srv.executeCommand(
      'curl -sS --cacert /etc/ssl/certs/ca.crt https://127.0.0.1/');
    expect(out).not.toContain('Welcome to nginx!');
  });
});

describe('the two matching defects --cacert exposed', () => {
  /**
   * A SAN is stored as openssl spells it (`DNS:lab.local`). Comparing the
   * stored string against the hostname meant a certificate carrying a SAN
   * matched nothing at all — and since SAN takes precedence over the common
   * name, adding one made the certificate WORSE.
   */
  it('a certificate whose name is in a SAN matches the host it names', async () => {
    const srv = machine();
    await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/srv.key '
      + '-out /etc/ssl/certs/srv.crt -days 365 -nodes -subj "/CN=unrelated.lab" '
      + '-addext "subjectAltName=DNS:127.0.0.1"');
    await serve(srv);

    const out = await srv.executeCommand(
      'curl -sS --cacert /etc/ssl/certs/srv.crt https://127.0.0.1/');
    expect(out).toContain('Welcome to nginx!');
  });

  /**
   * And the fallback: no SAN, so the common name decides — spelled the way
   * this machine's own `openssl req` renders it, with spaces around the `=`.
   */
  it('a certificate with no SAN matches on its common name', async () => {
    const srv = machine();
    await srv.executeCommand('mkdir -p /etc/ssl/certs /etc/ssl/private');
    await srv.executeCommand(
      'openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/private/srv.key '
      + '-out /etc/ssl/certs/srv.crt -days 365 -nodes -subj "/CN=127.0.0.1"');
    await serve(srv);

    // The rendering the matcher has to cope with, stated as a fact rather
    // than assumed: this is what the machine itself prints.
    expect(await srv.executeCommand('openssl x509 -in /etc/ssl/certs/srv.crt -noout -subject'))
      .toContain('CN = 127.0.0.1');

    const out = await srv.executeCommand(
      'curl -sS --cacert /etc/ssl/certs/srv.crt https://127.0.0.1/');
    expect(out).toContain('Welcome to nginx!');
  });
});
