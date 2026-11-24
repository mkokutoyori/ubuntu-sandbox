/*
 * Probe: RadSec (RADIUS over TLS, RFC 6614) did not exist: PRD-RADIUS carried it as out of scope and a `tls` section in a listen
 * block was ignored. Source of truth: RFC 6614 (TCP port 2083, TLS 1.2+ with mutual authentication, the shared secret is the
 * constant "radsec", packets are the ordinary RADIUS wire format on the TLS stream, several requests per connection),
 * FreeRADIUS v3.2.x raddb/sites-available/tls (listen { type = auth+acct port = 2083 proto = tcp tls { private_key_file,
 * certificate_file, ca_file, require_client_cert } }). The listener is real TLS on the simulated TCP stack: the handshake, the
 * client certificate check against ca_file and the encrypted RADIUS packets all cross the cable. Keys of the tls section the simulator
 * does not honour are refused naming them (rule 6).
 *
 * Discriminated with git stash on src: 7 of 10 fall before the fix; three pass either way and are named: the witness (the plain UDP
 * path of the same server answers) and the two refusals of a client with no certificate or a foreign one, which also fail on the base
 * because nothing listens there; their positive twin, a client with a valid certificate accepted, is the second case and falls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { certToPem, privateKeyToPem } from '@/network/pki/pem';
import { radSecExchange, RADSEC_SECRET } from '@/network/radius/RadSecTransport';
import { attr, encryptUserPassword, type RadiusPacket } from '@/network/radius/types';
import { randomRequestAuthenticator, verifyResponseAuthenticator, withMessageAuthenticator } from '@/network/radius/authenticators';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const DIR = '/etc/freeradius/3.0';
const SITE = `${DIR}/sites-available/default`;
const NOW = simulationNowMs();
const FIVE_YEARS = 5 * 365 * 24 * 3600 * 1000;

function certificates() {
  const authority = CertificateAuthority.generate('CN=Lab CA', { now: NOW });
  const issue = (subject: string, alt: string[] = []) => authority.issueCertificate({ subject, notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS, ...(alt.length > 0 ? { subjectAltNames: alt } : {}) });
  const other = CertificateAuthority.generate('CN=Other CA', { now: NOW });
  return {
    authority, server: issue('CN=radius.lab', ['DNS:radius.lab']), client: issue('CN=nas1'),
    stranger: other.issueCertificate({ subject: 'CN=nas2', notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS }),
  };
}

const TLS_BLOCK = (extra = '', require = 'yes') => `\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n\t\t\tca_file = ${DIR}/certs/ca.pem\n\t\t\trequire_client_cert = ${require}\n${extra}\t\t}\n\t}\n`;

async function lab(options: { block?: string; skipFiles?: boolean } = {}) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'NAS');
  const target = new LinuxServer('linux-server', 'RADIUS');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client nas {\n  ipaddr = 10.0.0.1\n  proto = *\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  const pki = certificates();
  if (options.skipFiles !== true) {
    vfsOf(target).mkdirp(`${DIR}/certs`, 0o755, 0, 0);
    write(target, `${DIR}/certs/server.pem`, certToPem(pki.server.cert));
    write(target, `${DIR}/certs/server.key`, privateKeyToPem(pki.server.privateKey));
    write(target, `${DIR}/certs/ca.pem`, certToPem(pki.authority.rootCertificate));
  }
  const site = vfsOf(target).readFile(SITE) ?? '';
  write(target, SITE, site.replace('server default {\n', `server default {\n${options.block ?? TLS_BLOCK()}`));
  const started = await target.executeCommand('systemctl restart freeradius');
  return { client, target, pki, started };
}

function request(password: string, secret = RADSEC_SECRET): RadiusPacket {
  const authenticator = randomRequestAuthenticator();
  const base: RadiusPacket = {
    type: 'radius', code: 'access-request', identifier: 7, authenticator,
    attributes: [attr('user-name', 'alice'), attr('user-password', encryptUserPassword(password, secret, authenticator))],
  };
  return withMessageAuthenticator(base, authenticator, RADSEC_SECRET);
}

function tlsConfig(pki: ReturnType<typeof certificates>, mutual: 'client' | 'stranger' | 'none') {
  const leaf = mutual === 'client' ? pki.client : mutual === 'stranger' ? pki.stranger : null;
  return {
    verifier: new CertificateVerifier({ trustAnchors: [pki.authority.rootCertificate], clock: () => NOW }),
    serverName: 'radius.lab', verifyHostname: true, versions: ['1.2' as const],
    ...(leaf === null ? {} : { clientCert: leaf.cert, clientPrivateKey: leaf.privateKey }),
  };
}

const exchange = (made: Awaited<ReturnType<typeof lab>>, password: string, mutual: 'client' | 'stranger' | 'none' = 'client', secret = RADSEC_SECRET) =>
  radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request(password, secret), tlsConfig(made.pki, mutual));

describe('RadSec (RADIUS over TLS)', () => {
  it('witness: the plain UDP path of the same server answers', async () => {
    const { client } = await lab({ block: '' });
    expect(await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('answers an Access-Request over mutual TLS with an Access-Accept signed with the radsec secret', async () => {
    const made = await lab();
    const sent = request('wonderland');
    const outcome = radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, sent, tlsConfig(made.pki, 'client'));
    expect(outcome.ok).toBe(true);
    expect(outcome.reply?.code).toBe('access-accept');
    expect(outcome.reply?.identifier).toBe(7);
    expect(verifyResponseAuthenticator(outcome.reply!, sent.authenticator, RADSEC_SECRET)).toBe(true);
  });

  it('answers a wrong password with an Access-Reject', async () => {
    const made = await lab();
    expect(exchange(made, 'wrong').reply?.code).toBe('access-reject');
  });

  it('the secret of a RadSec connection is radsec: a password hidden with the client secret fails', async () => {
    const made = await lab();
    expect(exchange(made, 'wonderland', 'client', 'shared').reply?.code).toBe('access-reject');
  });

  it('refuses a client that shows no certificate when require_client_cert = yes', async () => {
    const made = await lab();
    expect(exchange(made, 'wonderland', 'none').ok).toBe(false);
  });

  it('refuses a client certificate issued by an authority that is not ca_file', async () => {
    const made = await lab();
    expect(exchange(made, 'wonderland', 'stranger').ok).toBe(false);
  });

  it('accepts a client without a certificate when require_client_cert = no', async () => {
    const made = await lab({ block: TLS_BLOCK('', 'no') });
    expect(exchange(made, 'wonderland', 'none').reply?.code).toBe('access-accept');
  });

  it('listens on 2083 under the freeradius name, and the plain UDP listeners still answer', async () => {
    const made = await lab();
    expect(await made.target.executeCommand('ss -ltnp')).toMatch(/:2083\s.*freeradius/);
    expect(await made.client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });

  it('refuses a tls key it cannot honour, naming it', async () => {
    const made = await lab({ block: TLS_BLOCK('\t\t\trandom_file = x\n') });
    expect(made.started).toContain('The tls setting "random_file" is not implemented in this simulator');
  });

  it('refuses a tls section without proto = tcp, and a missing certificate file', async () => {
    const noProto = await lab({ block: TLS_BLOCK().replace('\t\tproto = tcp\n', '') });
    expect(noProto.started).toContain('A tls section needs proto = tcp');
    const missing = await lab({ skipFiles: true });
    expect(missing.started).toContain('Failed reading certificate_file');
  });
});
