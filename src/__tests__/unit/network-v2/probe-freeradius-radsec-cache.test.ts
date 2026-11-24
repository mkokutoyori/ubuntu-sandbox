/*
 * Probe: the `cache { enable lifetime }` subsection of a RadSec tls section was refused as unknown, so a TLS client could never resume. Source of
 * truth: FreeRADIUS v3.2.x src/main/tls.c (cache_config: enable, lifetime in hours; the session cache is what lets a client resume instead of redoing
 * the handshake; `name`, `persist_dir` and `max_entries` configure the on-disk store of the real server and are refused here naming them) and RFC 8446
 * 2.2 / 4.6.1 (a resumed handshake offers a PSK taken from a NewSessionTicket, which a server redeems once). The listener now owns a ticket store when the
 * cache is enabled, issues a ticket after each full handshake with the cache lifetime, and resumes a client that presents a live, unused one; the client
 * side of radSecExchange reports the ticket it received and whether the handshake was a resumption. A pooled proxy connection does not reuse tickets yet
 * (TODO.md). The listener of the probe requires a client certificate, as RadSec does: a resumed handshake carries the identity of the first one
 * (the ticket remembers the verified chain), which the TLS stack did not do before this commit: it still waited for a Certificate message that a PSK
 * handshake never carries and rejected the resumed client (measured: bad_record_mac on the client, unexpected_message on the server). *
 * Discriminated with git stash on src, in two steps: the cache commit (4 of 6 cases fall before it, with a listener that needs no client certificate) and the mutual-TLS fix that follows (the resumption cases fall again before it with the certificate required); two pass either way and are named: the witness (no cache: no ticket is issued) and the
 * single-use case (a ticket that was already redeemed is not resumed: on the base nothing was ever resumed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTimeScheduler, __setDefaultScheduler, getDefaultScheduler } from '@/events/Scheduler';
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




const CACHE = (inner = '\t\t\t\tenable = yes\n') => `\t\t\tcache {\n${inner}\t\t\t}\n`;
const WITH = (extra: string) => `\tlisten {\n\t\ttype = auth+acct\n\t\tipaddr = *\n\t\tport = 2083\n\t\tproto = tcp\n\t\ttls {\n\t\t\tprivate_key_file = ${DIR}/certs/server.key\n\t\t\tcertificate_file = ${DIR}/certs/server.pem\n\t\t\tca_file = ${DIR}/certs/ca.pem\n\t\t\trequire_client_cert = yes\n\t\t\ttls_min_version = "1.3"\n\t\t\ttls_max_version = "1.3"\n${extra}\t\t}\n\t}\n`;
const go = (made: Awaited<ReturnType<typeof lab>>, ticket?: import('@/network/tls/sessionTickets').SessionTicket | null) =>
  radSecExchange(made.client.getTcpStack(), '10.0.0.2', 2083, request('wonderland'), { ...tlsConfig(made.pki, 'client', ['1.3']), ...(ticket ? { resumptionTicket: ticket } : {}) });

describe('tls cache (session resumption)', () => {
  it('witness: with no cache subsection the server issues no ticket', async () => {
    const made = await lab({ block: WITH('') });
    const first = go(made);
    expect(first.reply?.code).toBe('access-accept');
    expect(first.ticket ?? null).toBeNull();
  });

  it('with the cache enabled a full handshake leaves the client a ticket', async () => {
    const made = await lab({ block: WITH(CACHE()) });
    const first = go(made);
    expect(first.resumed).toBe(false);
    expect(first.ticket).not.toBeNull();
  });

  it('a client that presents the ticket resumes: the handshake is a resumption and the request is served', async () => {
    const made = await lab({ block: WITH(CACHE()) });
    const ticket = go(made).ticket!;
    const second = go(made, ticket);
    expect(second.reply?.code).toBe('access-accept');
    expect(second.resumed).toBe(true);
  });

  it('a ticket is redeemed once: presenting it a second time does not resume', async () => {
    const made = await lab({ block: WITH(CACHE()) });
    const ticket = go(made).ticket!;
    go(made, ticket);
    expect(go(made, ticket).resumed ?? false).toBe(false);
  });

  it('lifetime is in hours: a ticket older than the cache lifetime is not accepted', async () => {
    __setDefaultScheduler(new VirtualTimeScheduler());
    const made = await lab({ block: WITH(CACHE('\t\t\t\tenable = yes\n\t\t\t\tlifetime = 1\n')) });
    const ticket = go(made).ticket!;
    const fresh = go(made, ticket);
    expect(fresh.resumed).toBe(true);
    const second = fresh.ticket!;
    await (getDefaultScheduler() as VirtualTimeScheduler).advanceBy(2 * 3600 * 1000);
    expect(go(made, second).resumed ?? false).toBe(false);
  });

  it('refuses the on-disk cache settings and a value that is not a boolean, naming them', async () => {
    expect((await lab({ block: WITH(CACHE('\t\t\t\tenable = yes\n\t\t\t\tpersist_dir = /tmp\n')) })).started).toContain('The cache setting "persist_dir" is not implemented in this simulator');
    expect((await lab({ block: WITH(CACHE('\t\t\t\tenable = maybe\n')) })).started).toContain('Invalid value "maybe" for variable enable');
  });

  it('a resumed connection keeps the identity of the first: check_cert_cn still sees the client certificate', async () => {
    const made = await lab({ block: WITH(CACHE() + '\t\t\tcheck_cert_cn = nas1\n') });
    const ticket = go(made).ticket!;
    const second = go(made, ticket);
    expect(second.resumed).toBe(true);
    expect(second.reply?.code).toBe('access-accept');
  });
});

