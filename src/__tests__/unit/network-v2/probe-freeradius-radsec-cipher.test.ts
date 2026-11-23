/*
 * Probe: cipher_list and cipher_suites of a tls section were refused as unknown keys, so the suites a RadSec peer may negotiate could not
 * be restricted. Source of truth: FreeRADIUS v3.2.x src/main/tls.c (cipher_list goes to SSL_CTX_set_cipher_list, the TLS 1.2 and earlier
 * suites in OpenSSL's grammar, "Failed setting cipher_list" when the string selects nothing; cipher_suites goes to
 * SSL_CTX_set_ciphersuites for TLS 1.3, "Failed setting cipher_suites"). Both are now passed to the TLS stack, which already parses the
 * OpenSSL grammar and only offers the suites it implements; the RadSec listener and the RadSec home server use them.
 *
 * Discriminated with git stash on src: 4 of 5 fall before the fix; the witness (default suites handshake) passes either way and is named.
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




const WITH = (extra: string) => TLS_BLOCK(extra);
const exchangeWith = (made: Awaited<ReturnType<typeof lab>>, versions: readonly ('1.2' | '1.3')[], override: Record<string, unknown>) =>
  radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request('wonderland'), { ...tlsConfig(made.pki, 'client', versions), ...override });

describe('cipher_list and cipher_suites', () => {
  it('witness: with no cipher setting the default suites handshake', async () => {
    const made = await lab({ block: WITH('') });
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('cipher_list restricts the TLS 1.2 suites: a peer with no suite in common is refused, one that shares a suite is served', async () => {
    const made = await lab({ block: WITH('\t\t\tcipher_list = "ECDHE-RSA-AES128-GCM-SHA256"\n') });
    expect(exchangeWith(made, ['1.2'], { cipherList: 'ECDHE-RSA-AES256-GCM-SHA384' }).ok).toBe(false);
    expect(exchangeWith(made, ['1.2'], { cipherList: 'ECDHE-RSA-AES128-GCM-SHA256' }).reply?.code).toBe('access-accept');
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('cipher_suites restricts the TLS 1.3 suites', async () => {
    const made = await lab({ block: WITH('\t\t\ttls_max_version = "1.3"\n\t\t\tcipher_suites = "TLS_AES_128_GCM_SHA256"\n') });
    expect(exchangeWith(made, ['1.3'], { tls13Ciphersuites: 'TLS_AES_256_GCM_SHA384' }).ok).toBe(false);
    expect(exchangeWith(made, ['1.3'], { tls13Ciphersuites: 'TLS_AES_128_GCM_SHA256' }).reply?.code).toBe('access-accept');
  });

  it('a cipher_list that selects nothing and a cipher_suites that names no known suite refuse the start, in the words of the source', async () => {
    expect((await lab({ block: WITH('\t\t\tcipher_list = "NOSUCHCIPHER"\n') })).started).toContain('Failed setting cipher_list');
    expect((await lab({ block: WITH('\t\t\tcipher_suites = "FOO"\n') })).started).toContain('Failed setting cipher_suites');
  });

  it('a tls section inside a client honours them too, for that client only', async () => {
    const made = await lab({ clients: `client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n  tls {\n    private_key_file = ${DIR}/certs/server.key\n    certificate_file = ${DIR}/certs/server.pem\n    ca_file = ${DIR}/certs/ca.pem\n    cipher_list = "ECDHE-RSA-AES128-GCM-SHA256"\n  }\n}\n` });
    expect(exchangeWith(made, ['1.2'], { cipherList: 'ECDHE-RSA-AES256-GCM-SHA384' }).ok).toBe(false);
    expect(exchangeWith(made, ['1.2'], {}).reply?.code).toBe('access-accept');
  });
});
