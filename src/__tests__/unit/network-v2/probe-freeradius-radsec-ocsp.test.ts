/*
 * Probe: the ocsp subsection of a tls section was refused as an unknown key, so a revoked client certificate could not be turned away by
 * its responder. Source of truth: FreeRADIUS v3.2.x src/main/tls.c (ocsp { enable url override_cert_url use_nonce timeout softfail }; ocsp_check:
 * the responder is the AIA URL of the certificate unless override_cert_url, else the configured url; a good status passes; a revoked or
 * unknown status, a bad response status, a wrong nonce, an unverifiable response or invalid times fail with "ocsp: Cert status: ..." and
 * "(TLS) ocsp: Certificate has been expired/revoked"; no responder URL, no connection or no answer are "skipped": with softfail = yes the
 * certificate is assumed valid, otherwise "(TLS) ocsp: Unable to check certificate, failing"). The query is the existing wire client
 * (HTTP POST application/ocsp-request over the simulated TCP stack, answered by `openssl ocsp -port` on another machine), with the PKI of the lab
 * built by the openssl commands of that machine. Only the tls section of a listener or of a client has an ocsp subsection, as in the source (the
 * home_server tls section has none). A host name in the URL is not resolved (TODO.md).
 *
 * Discriminated with git stash on src: 7 of 8 fall before the fix; the witness (ocsp not enabled: a revoked client is served) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { pemToCert, pemToPrivateKey } from '@/network/pki/pem';
import { simulationNowMs } from '@/network/core/SystemClock';
import { radSecExchange, RADSEC_SECRET } from '@/network/radius/RadSecTransport';
import { attr, encryptUserPassword, type RadiusPacket } from '@/network/radius/types';
import { randomRequestAuthenticator, withMessageAuthenticator } from '@/network/radius/authenticators';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const read = (server: LinuxServer, path: string) => vfsOf(server).readFile(path) ?? '';
const DIR = '/etc/freeradius/3.0';
const SITE = `${DIR}/sites-available/default`;
const CA = '/etc/ssl/CA';
const AIA = 'http://10.0.0.3:2560';
const sh = (server: LinuxServer, command: string) => server.executeCommand(command);

const TLS_BLOCK = (ocsp: string) => `\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n\t\t\tca_file = ${DIR}/certs/ca.pem\n\t\t\trequire_client_cert = yes\n\t\t\ttls_max_version = "1.3"\n${ocsp}\t\t}\n\t}\n`;
const OCSP = (body: string) => `\t\t\tocsp {\n${body}\t\t\t}\n`;

async function issue(pki: LinuxServer, name: string, ext: string) {
  await sh(pki, `sh -c 'printf "${ext}" > /tmp/${name}.ext'`);
  await sh(pki, `openssl req -new -newkey rsa:1024 -nodes -keyout /tmp/${name}.key -out /tmp/${name}.csr -subj "/CN=${name}"`);
  await sh(pki, `openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -in /tmp/${name}.csr -extfile /tmp/${name}.ext -out /tmp/${name}.crt -days 30`);
}

async function lab(ocsp: string, options: { responder?: boolean } = {}) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'NAS');
  const target = new LinuxServer('linux-server', 'RADIUS');
  const pki = new LinuxServer('linux-server', 'PKI');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, pki, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(pki.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  pki.configureInterface('eth0', new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
  await sh(pki, `mkdir -p ${CA}`);
  await sh(pki, `openssl req -x509 -newkey rsa:1024 -keyout ${CA}/ca.key -out ${CA}/ca.crt -days 365 -nodes -subj "/CN=Lab CA"`);
  await issue(pki, 'server', `subjectAltName=DNS:radius.lab\\nauthorityInfoAccess=OCSP;URI:${AIA}\\n`);
  await issue(pki, 'good', `authorityInfoAccess=OCSP;URI:${AIA}\\n`);
  await issue(pki, 'bad', `authorityInfoAccess=OCSP;URI:${AIA}\\n`);
  await issue(pki, 'plain', 'basicConstraints=CA:FALSE\\n');
  await sh(pki, `openssl ca -batch -cert ${CA}/ca.crt -keyfile ${CA}/ca.key -revoke /tmp/bad.crt`);
  if (options.responder !== false) await sh(pki, `openssl ocsp -index ${CA}/index.txt -CA ${CA}/ca.crt -rkey ${CA}/ca.key -port 2560 &`);
  write(target, CLIENTS_CONF_PATH, 'client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  vfsOf(target).mkdirp(`${DIR}/certs`, 0o755, 0, 0);
  write(target, `${DIR}/certs/server.pem`, read(pki, '/tmp/server.crt'));
  write(target, `${DIR}/certs/server.key`, read(pki, '/tmp/server.key'));
  write(target, `${DIR}/certs/ca.pem`, read(pki, `${CA}/ca.crt`));
  write(target, SITE, (read(target, SITE)).replace('server default {\n', `server default {\n${TLS_BLOCK(ocsp)}`));
  const started = await sh(target, 'systemctl restart freeradius');
  return { client, target, pki, started };
}

function request(): RadiusPacket {
  const authenticator = randomRequestAuthenticator();
  const base: RadiusPacket = { type: 'radius', code: 'access-request', identifier: 7, authenticator, attributes: [attr('user-name', 'alice'), attr('user-password', encryptUserPassword('wonderland', RADSEC_SECRET, authenticator))] };
  return withMessageAuthenticator(base, authenticator, RADSEC_SECRET);
}

function exchange(made: Awaited<ReturnType<typeof lab>>, name: string) {
  const ca = pemToCert(read(made.pki, `${CA}/ca.crt`))!;
  return radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request(), {
    verifier: new CertificateVerifier({ trustAnchors: [ca], clock: () => simulationNowMs() }),
    serverName: 'radius.lab', verifyHostname: true, versions: ['1.3'],
    clientCert: pemToCert(read(made.pki, `/tmp/${name}.crt`))!, clientPrivateKey: pemToPrivateKey(read(made.pki, `/tmp/${name}.key`))!,
  });
}

describe('tls ocsp', () => {
  it('witness: with ocsp not enabled a revoked client certificate is served', async () => {
    const made = await lab('');
    expect(exchange(made, 'bad').reply?.code).toBe('access-accept');
  });

  it('enable = yes: the AIA responder says good for one client and revoked for the other', async () => {
    const made = await lab(OCSP('\t\t\t\tenable = yes\n'));
    expect(made.started).not.toContain('Failed');
    expect(exchange(made, 'good').reply?.code).toBe('access-accept');
    expect(exchange(made, 'bad').ok).toBe(false);
  });

  it('a revoked answer is logged in the words of the source', async () => {
    const made = await lab(OCSP('\t\t\t\tenable = yes\n'));
    exchange(made, 'bad');
    const log = read(made.target, '/var/log/freeradius/radius.log');
    expect(log).toContain('tls: ocsp: Cert status: revoked');
  });

  it('an unreachable responder fails the check, and softfail = yes assumes the certificate valid', async () => {
    const down = await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\toverride_cert_url = yes\n\t\t\t\turl = "http://10.0.0.3:2999/"\n'));
    expect(exchange(down, 'good').ok).toBe(false);
    expect(read(down.target, '/var/log/freeradius/radius.log')).toContain('tls: (TLS) ocsp: Unable to check certificate, failing');
    const soft = await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\toverride_cert_url = yes\n\t\t\t\turl = "http://10.0.0.3:2999/"\n\t\t\t\tsoftfail = yes\n'));
    expect(exchange(soft, 'good').reply?.code).toBe('access-accept');
    expect(read(soft.target, '/var/log/freeradius/radius.log')).toContain("Unable to check certificate, assuming it's valid");
  });

  it('override_cert_url sends the query to url instead of the AIA of the certificate', async () => {
    const made = await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\toverride_cert_url = yes\n\t\t\t\turl = "http://10.0.0.3:2999/"\n'));
    expect(exchange(made, 'bad').ok).toBe(false);
    const aia = await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\turl = "http://10.0.0.3:2999/"\n'));
    expect(exchange(aia, 'good').reply?.code).toBe('access-accept');
  });

  it('a certificate with no AIA falls back to url, and with neither is skipped: refused unless softfail', async () => {
    const withUrl = await lab(OCSP(`\t\t\t\tenable = yes\n\t\t\t\turl = "${AIA}/"\n`));
    expect(exchange(withUrl, 'plain').reply?.code).toBe('access-accept');
    const neither = await lab(OCSP('\t\t\t\tenable = yes\n'));
    expect(exchange(neither, 'plain').ok).toBe(false);
    const soft = await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\tsoftfail = yes\n'));
    expect(exchange(soft, 'plain').reply?.code).toBe('access-accept');
  });

  it('use_nonce = no is accepted by this responder as well', async () => {
    const made = await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\tuse_nonce = no\n'));
    expect(exchange(made, 'good').reply?.code).toBe('access-accept');
    expect(exchange(made, 'bad').ok).toBe(false);
  });

  it('refuses an ocsp key it does not honour and a value that is not a boolean, naming them', async () => {
    expect((await lab(OCSP('\t\t\t\tenable = yes\n\t\t\t\tcache_timeout = 5\n'), { responder: false })).started).toContain('The ocsp setting "cache_timeout" is not implemented in this simulator');
    expect((await lab(OCSP('\t\t\t\tenable = maybe\n'), { responder: false })).started).toContain('Invalid value "maybe" for variable enable');
  });
});
