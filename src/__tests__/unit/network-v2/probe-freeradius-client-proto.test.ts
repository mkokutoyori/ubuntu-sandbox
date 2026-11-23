/*
 * Probe: `proto` inside a client section was read and ignored, so a client declared for UDP was served over TLS and a TLS client over UDP.
 * Source of truth: FreeRADIUS v3.2.x src/main/client.c (client_parse: proto = udp | tcp | tls | radsec | *, "tls" and "radsec" set
 * tls_required, anything else logs `Unknown proto "%s".`; client_find compares the client's proto with the socket's, "*" is the dual
 * entry), raddb/sites-available/tls (client { proto = tls ... } with the secret "radsec"). A client now matches only on the transport its
 * packet arrived on; a tls_required client does not match a plain stream; its secret defaults to radsec.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; the witness (a proto = * client answers over UDP) passes either way
 * and is named.
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
import { certificateRejection, NO_TLS_LIMITS } from '@/network/radius/RadSecTlsPolicy';
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

async function lab(options: { block?: string; skipFiles?: boolean; clients?: string } = {}) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'NAS');
  const target = new LinuxServer('linux-server', 'RADIUS');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, options.clients ?? 'client nas {\n  ipaddr = 10.0.0.1\n  proto = *\n  secret = shared\n}\n');
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

function tlsConfig(pki: ReturnType<typeof certificates>, mutual: 'client' | 'stranger' | 'none', versions: readonly ('1.2' | '1.3')[] = ['1.2']) {
  const leaf = mutual === 'client' ? pki.client : mutual === 'stranger' ? pki.stranger : null;
  return {
    verifier: new CertificateVerifier({ trustAnchors: [pki.authority.rootCertificate], clock: () => NOW }),
    serverName: 'radius.lab', verifyHostname: true, versions: [...versions],
    ...(leaf === null ? {} : { clientCert: leaf.cert, clientPrivateKey: leaf.privateKey }),
  };
}

const exchange = (made: Awaited<ReturnType<typeof lab>>, versions: readonly ('1.2' | '1.3')[] = ['1.2']) =>
  radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request('wonderland'), tlsConfig(made.pki, 'client', versions));



const UDP_CLIENT = 'client nas {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n';
const TLS_CLIENT = 'client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n}\n';
const udp = (made: Awaited<ReturnType<typeof lab>>) => made.client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -t 1 -r 1 10.0.0.2 auth shared`);

describe('client proto', () => {
  it('witness: a proto = * client is served over UDP and over TLS', async () => {
    const made = await lab();
    expect(await udp(made)).toContain('Received Access-Accept');
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('a client with no proto is a UDP client: the TLS connection from the same address is not served', async () => {
    const made = await lab({ clients: UDP_CLIENT });
    expect(await udp(made)).toContain('Received Access-Accept');
    expect(exchange(made).ok).toBe(false);
  });

  it('a proto = tls client is served over TLS with no secret written, and not over UDP', async () => {
    const made = await lab({ clients: TLS_CLIENT });
    expect(exchange(made).reply?.code).toBe('access-accept');
    expect(await udp(made)).toContain('No reply from server');
  });

  it('radsec is the alias of tls', async () => {
    const made = await lab({ clients: TLS_CLIENT.replace('proto = tls', 'proto = radsec') });
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('a UDP client and a TLS client may share an address, each answered on its own transport', async () => {
    const made = await lab({ clients: UDP_CLIENT + TLS_CLIENT.replace('nas', 'nas-tls') });
    expect(await udp(made)).toContain('Received Access-Accept');
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('refuses an unknown proto in the words of the source', async () => {
    const made = await lab({ clients: 'client nas {\n  ipaddr = 10.0.0.1\n  proto = sctp\n  secret = shared\n}\n' });
    expect(made.started).toContain('Unknown proto "sctp".');
  });
});
