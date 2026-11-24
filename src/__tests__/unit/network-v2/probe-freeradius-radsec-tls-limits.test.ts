/*
 * Probe: the tls section of a RadSec listener read tls_min_version, tls_max_version, check_cert_cn and check_cert_issuer as unknown
 * keys (refused) and always spoke TLS 1.3 only. Source of truth: FreeRADIUS v3.2.x src/main/tls.c (tls_server_config defaults: min
 * "1.2"; max taken from the configuration, and TLS 1.2 when absent "we only use TLS 1.3 if it's EXPLICITLY ENABLED"; the error texts
 * "Invalid value for tls_max_version", "Unknown or unsupported value for tls_min_version", "tls_min_version must be <= tls_max_version";
 * the verify callback: check_cert_issuer compared with the X509_NAME_oneline issuer, check_cert_cn with the common name, a mismatch
 * logged as AUTH "Certificate issuer (..) does not match specified value (..)!" / "Certificate CN (..) does not match specified value
 * (..)!" and the handshake failing), raddb/sites-available/tls (tls_min_version = "1.2", tls_max_version = "1.3"). The version range
 * now selects the protocols the TLS stack offers; the certificate checks run on the client certificate after the handshake and close the
 * connection. check_cert_cn with an expansion is refused (a handshake has no request to expand it against).
 *
 * Discriminated with git stash on src: all 9 cases fall before the fix. Even the witness falls: on base the listener spoke TLS 1.3 only, so a
 * TLS 1.2 client (the real default of both ends) was refused; the lab itself is proven sound by the case that follows the version range
 * with tls_max_version = 1.3 and by the matching cn/issuer cases, which succeed through the same lab.
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


const BASE_TLS = (extra: string) => TLS_BLOCK(extra);

describe('RadSec TLS limits', () => {
  it('witness: a default listener answers a TLS 1.2 client', async () => {
    const made = await lab();
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('without tls_max_version the listener stops at TLS 1.2: a TLS 1.3-only client is refused', async () => {
    const made = await lab();
    expect(exchange(made, ['1.3']).ok).toBe(false);
  });

  it('tls_max_version = 1.3 lets a TLS 1.3 client in', async () => {
    const made = await lab({ block: BASE_TLS('\t\t\ttls_max_version = "1.3"\n') });
    expect(exchange(made, ['1.3']).reply?.code).toBe('access-accept');
  });

  it('tls_min_version = 1.3 refuses a TLS 1.2-only client', async () => {
    const made = await lab({ block: BASE_TLS('\t\t\ttls_min_version = "1.3"\n\t\t\ttls_max_version = "1.3"\n') });
    expect(exchange(made, ['1.2']).ok).toBe(false);
    expect(exchange(made, ['1.3']).reply?.code).toBe('access-accept');
  });

  it('check_cert_cn equal to the client certificate common name lets it in, another value refuses it', async () => {
    const same = await lab({ block: BASE_TLS('\t\t\tcheck_cert_cn = nas1\n') });
    expect(exchange(same).reply?.code).toBe('access-accept');
    const other = await lab({ block: BASE_TLS('\t\t\tcheck_cert_cn = nas9\n') });
    expect(exchange(other).ok).toBe(false);
  });

  it('a refused common name is logged as the real server logs it', async () => {
    const made = await lab({ block: BASE_TLS('\t\t\tcheck_cert_cn = nas9\n') });
    exchange(made);
    expect(vfsOf(made.target).readFile('/var/log/freeradius/radius.log') ?? '').toContain('Certificate CN (nas1) does not match specified value (nas9)!');
  });

  it('check_cert_issuer is compared with the issuer written as OpenSSL oneline', async () => {
    const same = await lab({ block: BASE_TLS('\t\t\tcheck_cert_issuer = "/CN=Lab CA"\n') });
    expect(exchange(same).reply?.code).toBe('access-accept');
    const other = await lab({ block: BASE_TLS('\t\t\tcheck_cert_issuer = "/CN=Elsewhere"\n') });
    expect(exchange(other).ok).toBe(false);
  });

  it('refuses an invalid version, an inverted range and an expansion in check_cert_cn, in the real words', async () => {
    expect((await lab({ block: BASE_TLS('\t\t\ttls_max_version = "9.9"\n') })).started).toContain("Invalid value for tls_max_version '9.9'");
    expect((await lab({ block: BASE_TLS('\t\t\ttls_min_version = "7"\n') })).started).toContain("Unknown or unsupported value for tls_min_version '7'");
    expect((await lab({ block: BASE_TLS('\t\t\ttls_min_version = "1.3"\n\t\t\ttls_max_version = "1.2"\n') })).started).toContain("tls_min_version '1.3' must be <= tls_max_version '1.2'");
    expect((await lab({ block: BASE_TLS('\t\t\tcheck_cert_cn = %{User-Name}\n') })).started).toContain('is an expansion');
  });

  it('the client side checks the certificate of the server it reaches: a name that differs makes the exchange fail', async () => {
    const made = await lab();
    const tcp = made.client.getTcpStack();
    const good = radSecExchange(tcp, '10.0.0.2', 2083, request('wonderland'), tlsConfig(made.pki, 'client'), (certificate) => certificateRejection(certificate, { ...NO_TLS_LIMITS, checkCertCn: 'radius.lab' }));
    const bad = radSecExchange(tcp, '10.0.0.2', 2083, request('wonderland'), tlsConfig(made.pki, 'client'), (certificate) => certificateRejection(certificate, { ...NO_TLS_LIMITS, checkCertCn: 'other.lab' }));
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('Certificate CN (radius.lab) does not match specified value (other.lab)!');
  });
});
