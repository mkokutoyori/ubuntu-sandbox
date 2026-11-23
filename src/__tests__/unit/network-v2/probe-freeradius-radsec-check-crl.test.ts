/*
 * Probe: check_crl and allow_expired_crl of a tls section were refused as unknown keys, so a revoked client certificate could not be
 * refused. Source of truth: FreeRADIUS v3.2.x src/main/tls.c (check_crl = yes sets X509_V_FLAG_CRL_CHECK on the store: the CRL of the
 * certificate's issuer must be there, loaded from ca_file / ca_path, and a certificate it lists is refused; a missing CRL fails
 * verification as "unable to get certificate CRL"; allow_expired_crl keeps an expired CRL usable; check_all_crl (now evaluated, see the depth probe) extends the check
 * to the whole chain, is not implemented and stays refused). The same options now serve the RadSec listener, the RadSec home server and
 * the eap module's tls-config through one verifier builder.
 *
 * Discriminated with git stash on src: 3 of 6 fall before the fix; three pass either way and are named: the witness (check_crl = no ignores a
 * CRL that lists the client: the listener starts and serves it) and the two refusals (a listed client, a CRL-less ca_file), which pass on the
 * base only because the base refuses the key, the listener never starts and nobody is served; the cases that fall are their positive twins.
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
import { certToPem, privateKeyToPem, crlToPem } from '@/network/pki/pem';
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




const DAY = 24 * 3600 * 1000;
const WITH = (extra: string) => TLS_BLOCK(extra);

async function crlLab(extra: string, revoke: boolean, crl: 'fresh' | 'stale' | 'none') {
  const made = await lab({ block: WITH(extra) });
  if (revoke) made.pki.authority.revoke(made.pki.client.cert.serialNumber, NOW);
  const list = crl === 'none' ? '' : crlToPem(made.pki.authority.publishCRL(crl === 'fresh' ? NOW : NOW - 3 * DAY, DAY));
  write(made.target, `${DIR}/certs/ca.pem`, certToPem(made.pki.authority.rootCertificate) + list);
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  return { ...made, restarted };
}

describe('check_crl', () => {
  it('witness: with check_crl = no a CRL that lists the client is ignored', async () => {
    const made = await crlLab('', true, 'fresh');
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('check_crl = yes serves a client the CRL does not list', async () => {
    const made = await crlLab('\t\t\tcheck_crl = yes\n', false, 'fresh');
    expect(made.restarted).not.toContain('Failed');
    expect(exchange(made).reply?.code).toBe('access-accept');
  });

  it('check_crl = yes refuses a client the CRL lists', async () => {
    const made = await crlLab('\t\t\tcheck_crl = yes\n', true, 'fresh');
    expect(exchange(made).ok).toBe(false);
  });

  it('check_crl = yes refuses every client when ca_file holds no CRL for the issuer', async () => {
    const made = await crlLab('\t\t\tcheck_crl = yes\n', false, 'none');
    expect(exchange(made).ok).toBe(false);
  });

  it('an expired CRL is refused, and used again with allow_expired_crl = yes', async () => {
    const stale = await crlLab('\t\t\tcheck_crl = yes\n', false, 'stale');
    expect(exchange(stale).ok).toBe(false);
    const allowed = await crlLab('\t\t\tcheck_crl = yes\n\t\t\tallow_expired_crl = yes\n', false, 'stale');
    expect(exchange(allowed).reply?.code).toBe('access-accept');
    const revokedAllowed = await crlLab('\t\t\tcheck_crl = yes\n\t\t\tallow_expired_crl = yes\n', true, 'stale');
    expect(exchange(revokedAllowed).ok).toBe(false);
  });

  it('refuses a value that is not a boolean, and ca_path_reload_interval, naming them', async () => {
    expect((await crlLab('\t\t\tcheck_crl = maybe\n', false, 'fresh')).started).toContain('Invalid value "maybe" for variable check_crl');
    expect((await crlLab('\t\t\tca_path_reload_interval = yes\n', false, 'fresh')).started).toContain('The tls setting "ca_path_reload_interval" is not implemented in this simulator');
  });
});
