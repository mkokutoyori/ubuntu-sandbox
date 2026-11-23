/*
 * Probe: verify_depth, check_all_crl and ca_path of a tls section were refused as unknown keys. Source of truth: FreeRADIUS v3.2.x
 * src/main/tls.c (verify_depth bounds the certificate chain, 0 leaving the default; check_all_crl adds X509_V_FLAG_CRL_CHECK_ALL: the CRL
 * of every issuer in the chain is consulted, not just the leaf's; ca_path is a directory of CA certificates and CRLs loaded next to ca_file by
 * X509_STORE_load_locations, "Failed reading ca_path" here when the directory is missing; ca_path_reload_interval is still refused). They
 * go through the one verifier builder and the one CA material reader.
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; two pass either way and are named: the witness (a chain with two
 * intermediates is accepted when no depth is set) and the check_all_crl case (its leaf-only half already worked with check_crl, and its refusal half
 * is satisfied on the base because the base refuses the key and the listener never starts: nobody is served).
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
const LONG = 5 * 365 * DAY;
const WITH = (extra: string, caFile = true) => `\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n${caFile ? `\t\t\tca_file = ${DIR}/certs/ca.pem\n` : ''}\t\t\trequire_client_cert = yes\n${extra}\t\t}\n\t}\n`;

async function deepLab(extra: string, options: { caFile?: boolean; setup?: (made: Awaited<ReturnType<typeof lab>>, chain: { root: CertificateAuthority; sub: CertificateAuthority; sub2: CertificateAuthority }) => void } = {}) {
  const made = await lab({ block: WITH(extra, options.caFile ?? true) });
  const root = made.pki.authority;
  const sub = root.issueSubordinateCA({ subject: 'CN=Sub CA', notBefore: NOW - 1000, notAfter: NOW + LONG });
  const sub2 = sub.issueSubordinateCA({ subject: 'CN=Sub2 CA', notBefore: NOW - 1000, notAfter: NOW + LONG });
  const leaf = sub2.issueCertificate({ subject: 'CN=nas1', notBefore: NOW - 1000, notAfter: NOW + LONG });
  options.setup?.(made, { root, sub, sub2 });
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  const config = {
    ...tlsConfig(made.pki, 'client'),
    clientCert: leaf.cert, clientPrivateKey: leaf.privateKey, clientChain: [sub2.rootCertificate, sub.rootCertificate],
  };
  const run = () => radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request('wonderland'), config);
  return { ...made, restarted, run, leaf, root, sub, sub2 };
}

describe('verify_depth, check_all_crl and ca_path', () => {
  it('witness: a chain with two intermediates is accepted when no depth is set', async () => {
    const made = await deepLab('');
    expect(made.run().reply?.code).toBe('access-accept');
  });

  it('verify_depth bounds the chain the client presents', async () => {
    expect((await deepLab('\t\t\tverify_depth = 1\n')).run().ok).toBe(false);
    expect((await deepLab('\t\t\tverify_depth = 2\n')).run().reply?.code).toBe('access-accept');
  });

  it('ca_path is read next to ca_file: the CA in a directory alone is enough, an empty directory trusts nobody', async () => {
    const found = await deepLab(`\t\t\tca_path = ${DIR}/cas\n`, { caFile: false, setup: (made) => { vfsOf(made.target).mkdirp(`${DIR}/cas`, 0o755, 0, 0); write(made.target, `${DIR}/cas/root.pem`, certToPem(made.pki.authority.rootCertificate)); } });
    expect(found.run().reply?.code).toBe('access-accept');
    const empty = await deepLab(`\t\t\tca_path = ${DIR}/cas\n`, { caFile: false, setup: (made) => { vfsOf(made.target).mkdirp(`${DIR}/cas`, 0o755, 0, 0); } });
    expect(empty.run().ok).toBe(false);
  });

  it('a ca_path that is not a directory refuses the start in the words of the file readers', async () => {
    const made = await lab({ block: WITH(`\t\t\tca_path = ${DIR}/absent\n`) });
    expect(made.started).toContain('Failed reading ca_path');
  });

  it('check_all_crl consults the CRL of every issuer: a revoked intermediate refuses the leaf, which the default leaf-only check misses', async () => {
    const setup = (made: Awaited<ReturnType<typeof lab>>, chain: { root: CertificateAuthority; sub: CertificateAuthority; sub2: CertificateAuthority }) => {
      chain.root.revoke(chain.sub.rootCertificate.serialNumber, NOW);
      const crls = [chain.root.publishCRL(NOW, DAY), chain.sub.publishCRL(NOW, DAY), chain.sub2.publishCRL(NOW, DAY)].map(crlToPem).join('');
      write(made.target, `${DIR}/certs/ca.pem`, certToPem(chain.root.rootCertificate) + crls);
    };
    const leafOnly = await deepLab('\t\t\tcheck_crl = yes\n', { setup });
    expect(leafOnly.run().reply?.code).toBe('access-accept');
    const all = await deepLab('\t\t\tcheck_crl = yes\n\t\t\tcheck_all_crl = yes\n', { setup });
    expect(all.run().ok).toBe(false);
  });

  it('refuses a verify_depth that is not a number and ca_path_reload_interval, naming them', async () => {
    expect((await lab({ block: WITH('\t\t\tverify_depth = deep\n') })).started).toContain('Invalid value for variable verify_depth');
    expect((await lab({ block: WITH('\t\t\tca_path_reload_interval = 60\n') })).started).toContain('The tls setting "ca_path_reload_interval" is not implemented in this simulator');
  });
});
