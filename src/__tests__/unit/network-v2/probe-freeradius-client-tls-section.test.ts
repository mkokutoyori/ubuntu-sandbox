/*
 * Probe: a `tls { }` section inside a `client` was not read (the client section was accepted and the section ignored). Source of truth:
 * FreeRADIUS v3.2.x src/main/client.c (client_parse: `tls = cf_section_sub_find(cs, "tls")`, `c->tls = tls_server_conf_parse(tls)`: "Client TLS
 * settings are taken from the _server_ configuration. See listen.c, where client->tls is used as listener->tls") and listen.c
 * (`if (client->tls) this->tls = client->tls;`: the connection of that client is served with the CLIENT's certificate, CA, version
 * range and check_cert_* instead of the listener's). The client's section is read with the same reader as the listener's (one grammar:
 * RadSecTlsSection), unsupported keys are refused naming them, and the TLS configuration is chosen per connection from the client the
 * peer address matches.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix (the client section was accepted and its tls section ignored, so
 * the checks it names never ran); the witness (a client with no tls section uses the listener configuration) passes either way and is named.
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




const OWN = (inner: string) => `client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n  tls {\n    private_key_file = ${DIR}/certs/server.key\n    certificate_file = ${DIR}/certs/server.pem\n    ca_file = ${DIR}/certs/ca.pem\n${inner}  }\n}\n`;
const ALT = (inner = '') => `client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n  tls {\n    private_key_file = ${DIR}/certs/alt.key\n    certificate_file = ${DIR}/certs/alt.pem\n    ca_file = ${DIR}/certs/ca.pem\n${inner}  }\n}\n`;

describe('client tls section', () => {
  it('witness: a proto = tls client with no tls section is served with the listener configuration', async () => {
    const made = await lab({ clients: 'client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n}\n' });
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('check_cert_cn of the client section is evaluated: the matching name is served, another is refused', async () => {
    const same = await lab({ clients: OWN('    check_cert_cn = nas1\n') });
    expect(exchange(same).reply?.code).toBe('access-accept');
    const other = await lab({ clients: OWN('    check_cert_cn = nas9\n') });
    expect(exchange(other).ok).toBe(false);
  });

  it('check_cert_issuer of the client section is evaluated', async () => {
    const other = await lab({ clients: OWN('    check_cert_issuer = "/CN=Elsewhere"\n') });
    expect(exchange(other).ok).toBe(false);
  });

  it('the connection of that client is served with the client certificate, not the listener one', async () => {
    const made = await lab({ clients: ALT() });
    const alt = made.pki.authority.issueCertificate({ subject: 'CN=alt.lab', notBefore: NOW - 1000, notAfter: NOW + 5 * 365 * 24 * 3600 * 1000, subjectAltNames: ['DNS:alt.lab'] });
    write(made.target, `${DIR}/certs/alt.pem`, certToPem(alt.cert));
    write(made.target, `${DIR}/certs/alt.key`, privateKeyToPem(alt.privateKey));
    expect(exchange(made).ok).toBe(false);
    const named = radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request('wonderland'), { ...tlsConfig(made.pki, 'client'), serverName: 'alt.lab' });
    expect(named.reply?.code).toBe('access-accept');
  });

  it('the version range of the client section replaces the listener one', async () => {
    const made = await lab({ clients: OWN('    tls_min_version = "1.3"\n    tls_max_version = "1.3"\n') });
    expect(exchange(made, ['1.2']).ok).toBe(false);
    expect(exchange(made, ['1.3']).reply?.code).toBe('access-accept');
  });

  it('refuses an unsupported key and a missing certificate_file in the section, in the words of the listener section', async () => {
    expect((await lab({ clients: OWN('    check_crl = yes\n') })).started).toContain('The tls setting "check_crl" is not implemented in this simulator');
    expect((await lab({ clients: 'client nas {\n  ipaddr = 10.0.0.1\n  proto = tls\n  tls {\n    private_key_file = x\n  }\n}\n' })).started).toContain('Failed to find "certificate_file" in the tls section');
  });
});
