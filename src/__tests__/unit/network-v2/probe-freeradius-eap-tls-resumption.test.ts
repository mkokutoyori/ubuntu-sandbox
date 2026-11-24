/*
 * Probe: EAP-TLS could not be resumed: the server concluded with Access-Accept as soon as it had verified the last client flight and dropped the reply
 * of its TLS session, which is where the NewSessionTicket sits. Source of truth: RFC 9190 section 2.1.2 (TLS 1.3 EAP-TLS: the server delivers the
 * ticket in one more EAP round before the EAP-Success, the peer acknowledges it with an empty response, a peer that presents the ticket resumes without a
 * certificate exchange), FreeRADIUS v3.2.x raddb/mods-available/eap (tls-config { cache { enable lifetime } } is the session cache of the eap module). The eap
 * section's cache subsection of tls-config was read for nothing; it is now read and, for plain EAP-TLS, issues and honours tickets. PEAP and TTLS keep their
 * inner authentication and receive no ticket (their resumption skips the inner phase: not done, TODO.md). Both ends of the exchange are real: the peer is
 * the project's EAP-TLS peer, driven round by round through radclient against the daemon.
 *
 * PEAP and TTLS: the ticket is issued only once the inner method has accepted (a ticket granted at the end of the tunnel handshake would let a peer that
 * failed its inner authentication resume), carries the authenticated inner user, and a resumed conversation skips the inner phase and acts as that user.
 * A resumed PEAP/TTLS conversation is rejected when the user the ticket names no longer exists (the witness is the accepted resumption above, same lab).
 * Discriminated with git stash on src/network: every case falls before the fix (the peer has no ticket accessor on the base); the cases pinning
 * 'no ticket' (no cache, failed inner) are non-regressions the fix keeps true and are the witnesses of the lab.
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
import { eapPacketFromWireHex, eapPacketToWireHex } from '@/network/radius/eap';
import { EapTlsPeerSession } from '@/network/radius/eaptls/EapTlsPeerSession';
import { TtlsPapInnerAuthPeer } from '@/network/radius/eaptls/TtlsInnerAuth';
import { PeapMd5InnerAuthPeer } from '@/network/radius/eaptls/PeapInnerAuth';
import { PeapMsChapV2InnerAuthPeer } from '@/network/radius/eaptls/PeapMsChapV2InnerAuth';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const DIR = '/etc/freeradius/3.0';
const NOW = simulationNowMs();
const FIVE_YEARS = 5 * 365 * 24 * 3600 * 1000;

const EAP = (type: string, extra = '', tlsExtra = '') => `eap {\n  default_eap_type = ${type}\n  tls-config tls-common {\n    private_key_file = ${DIR}/certs/server.key\n    certificate_file = ${DIR}/certs/server.pem\n    ca_file = ${DIR}/certs/ca.pem\n${tlsExtra}  }\n  ${type === 'md5' ? '' : `${type} {\n    tls = tls-common\n${extra}  }`}\n}\n`;

function pki() {
  const authority = CertificateAuthority.generate('CN=Lab CA', { now: NOW });
  const issue = (subject: string) => authority.issueCertificate({ subject, notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS });
  const other = CertificateAuthority.generate('CN=Other CA', { now: NOW });
  return {
    authority, server: issue('CN=radius.lab'), client: issue('CN=alice'),
    stranger: other.issueCertificate({ subject: 'CN=alice', notBefore: NOW - 1000, notAfter: NOW + FIVE_YEARS }),
    verifier: new CertificateVerifier({ trustAnchors: [authority.rootCertificate], clock: () => NOW }),
  };
}

async function lab(eapSection: string) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  const keys = pki();
  vfsOf(target).mkdirp(`${DIR}/certs`, 0o755, 0, 0);
  write(target, `${DIR}/certs/server.pem`, certToPem(keys.server.cert));
  write(target, `${DIR}/certs/server.key`, privateKeyToPem(keys.server.privateKey));
  write(target, `${DIR}/certs/ca.pem`, certToPem(keys.authority.rootCertificate));
  write(target, `${DIR}/mods-enabled/eap`, eapSection);
  const started = await target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  return { client, target, keys, started, lines };
}

const receivedOf = (output: string) => output.slice(output.lastIndexOf('Received'));
const piecesOf = (output: string, name: string) => Array.from(receivedOf(output).matchAll(new RegExp(`${name} = 0x([0-9a-f]+)`, 'g'))).map((match) => match[1]);
const hexOf = (output: string, name: string) => piecesOf(output, name).join('');
const mostPieces = { value: 0 };
const identityHex = (name: string) => `020000${(5 + name.length).toString(16).padStart(2, '0')}01${Buffer.from(name).toString('hex')}`;

const roundsOf = { value: 0 };

async function converse(made: Awaited<ReturnType<typeof lab>>, peer: EapTlsPeerSession): Promise<'accept' | 'reject' | 'stuck'> {
  roundsOf.value = 0;
  let reply = await made.client.executeCommand(`printf 'User-Name = "alice"\nEAP-Message = 0x${identityHex('alice')}\n' | radclient -x -r 1 -t 5 10.0.0.2 auth shared`);
  for (let round = 0; round < 200; round++) {
    if (reply.includes('Received Access-Accept')) return 'accept';
    if (reply.includes('Received Access-Reject')) return 'reject';
    roundsOf.value++;
    mostPieces.value = Math.max(mostPieces.value, piecesOf(reply, 'EAP-Message').length);
    const request = eapPacketFromWireHex(hexOf(reply, 'EAP-Message'));
    if (request === null) return 'stuck';
    const response = eapPacketToWireHex(peer.handle(request));
    reply = await made.client.executeCommand(`printf 'User-Name = "alice"\nState = 0x${hexOf(reply, 'State')}\nEAP-Message = 0x${response}\n' | radclient -x -r 1 -t 5 10.0.0.2 auth shared`);
  }
  return 'stuck';
}

const tlsPeer = (keys: ReturnType<typeof pki>, leaf: 'client' | 'stranger' = 'client') =>
  new EapTlsPeerSession((leaf === 'client' ? keys.client : keys.stranger).cert, keys.verifier, { clientPrivateKey: (leaf === 'client' ? keys.client : keys.stranger).privateKey });


const CACHE = (inner = '      enable = yes\n') => `    cache {\n${inner}    }\n`;
const resuming = (made: Awaited<ReturnType<typeof lab>>, ticket: import('@/network/tls/sessionTickets').SessionTicket) =>
  new EapTlsPeerSession(made.keys.client.cert, made.keys.verifier, { clientPrivateKey: made.keys.client.privateKey, resumptionTicket: ticket });
const fresh = (made: Awaited<ReturnType<typeof lab>>) =>
  new EapTlsPeerSession(made.keys.client.cert, made.keys.verifier, { clientPrivateKey: made.keys.client.privateKey });

describe('EAP-TLS resumption (RFC 9190)', () => {
  it('witness: without a cache the conversation is accepted and the peer receives no ticket', async () => {
    const made = await lab(EAP('tls'));
    const peer = fresh(made);
    expect(await converse(made, peer)).toBe('accept');
    expect(peer.ticket).toBeNull();
  });

  it('with the cache enabled a full conversation ends with the ticket round and leaves the peer a ticket', async () => {
    const made = await lab(EAP('tls', '', CACHE()));
    const peer = fresh(made);
    expect(await converse(made, peer)).toBe('accept');
    expect(peer.resumed).toBe(false);
    expect(peer.ticket).not.toBeNull();
  });

  it('a peer that presents the ticket resumes: accepted, resumed, in fewer rounds than the full conversation', async () => {
    const made = await lab(EAP('tls', '', CACHE()));
    const first = fresh(made);
    expect(await converse(made, first)).toBe('accept');
    const fullRounds = roundsOf.value;
    const second = resuming(made, first.ticket!);
    expect(await converse(made, second)).toBe('accept');
    expect(second.resumed).toBe(true);
    expect(roundsOf.value).toBeLessThan(fullRounds);
  });

  it('each resumed conversation leaves a new ticket: a third one resumes too', async () => {
    const made = await lab(EAP('tls', '', CACHE()));
    const first = fresh(made);
    await converse(made, first);
    const second = resuming(made, first.ticket!);
    await converse(made, second);
    expect(second.ticket).not.toBeNull();
    const third = resuming(made, second.ticket!);
    expect(await converse(made, third)).toBe('accept');
    expect(third.resumed).toBe(true);
  });

  it('a ticket is redeemed once: presenting it again falls back to a full conversation, still accepted', async () => {
    const made = await lab(EAP('tls', '', CACHE()));
    const first = fresh(made);
    await converse(made, first);
    await converse(made, resuming(made, first.ticket!));
    const again = resuming(made, first.ticket!);
    expect(await converse(made, again)).toBe('accept');
    expect(again.resumed).toBe(false);
  });

  const tunnelled = (made: Awaited<ReturnType<typeof lab>>, type: 'peap' | 'ttls', user: string, password: string, ticket?: import('@/network/tls/sessionTickets').SessionTicket) =>
    new EapTlsPeerSession(null, made.keys.verifier, {
      eapType: type,
      innerAuth: type === 'peap' ? new PeapMd5InnerAuthPeer(user, password) : new TtlsPapInnerAuthPeer(user, password),
      ...(ticket === undefined ? {} : { resumptionTicket: ticket }),
    });

  for (const type of ['peap', 'ttls'] as const) {
    it(`${type}: the ticket comes after the inner authentication and a peer presenting it resumes without the inner phase`, async () => {
      const made = await lab(EAP(type, '    default_eap_type = md5\n', CACHE()));
      const first = tunnelled(made, type, 'alice', 'wonderland');
      expect(await converse(made, first)).toBe('accept');
      expect(first.ticket).not.toBeNull();
      const fullRounds = roundsOf.value;
      const second = tunnelled(made, type, 'alice', 'wrong-password', first.ticket!);
      expect(await converse(made, second)).toBe('accept');
      expect(second.resumed).toBe(true);
      expect(roundsOf.value).toBeLessThan(fullRounds);
    });

    it(`${type}: a ticket does not outlive its user: resumed after the user is removed, the conversation is rejected`, async () => {
      const made = await lab(EAP(type, '    default_eap_type = md5\n', CACHE()));
      const first = tunnelled(made, type, 'alice', 'wonderland');
      expect(await converse(made, first)).toBe('accept');
      write(made.target, USERS_FILE_PATH, 'bob Cleartext-Password := "builder"\n');
      await made.target.executeCommand('systemctl restart freeradius');
      const second = tunnelled(made, type, 'alice', 'wonderland', first.ticket!);
      expect(await converse(made, second)).toBe('reject');
      expect(second.resumed).toBe(true);
    });

    it(`${type}: a failed inner authentication yields no ticket`, async () => {
      const made = await lab(EAP(type, '    default_eap_type = md5\n', CACHE()));
      const peer = tunnelled(made, type, 'alice', 'wrong-password');
      expect(await converse(made, peer)).toBe('reject');
      expect(peer.ticket).toBeNull();
    });

    it(`${type}: without the cache no ticket is issued`, async () => {
      const made = await lab(EAP(type, '    default_eap_type = md5\n'));
      const peer = tunnelled(made, type, 'alice', 'wonderland');
      expect(await converse(made, peer)).toBe('accept');
      expect(peer.ticket).toBeNull();
    });
  }
});
