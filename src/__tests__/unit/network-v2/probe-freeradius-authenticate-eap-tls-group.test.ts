/*
 * Probe: an `Auth-Type eap` group written by the operator in authenticate, for an EAP-TLS conversation. Source of truth: FreeRADIUS v3.2.x src/main/auth.c (the eap module sets Auth-Type = eap
 * and the group of that name runs as a program; only ok / handled authenticate), the rule probe-freeradius-authenticate-eap-group measured for EAP-MD5.
 *
 * Measured on the unmodified tree: all 5 cases pass. TODO.md said the group did not run for EAP-TLS, PEAP and TTLS; that was false (replyEap calls the authenticate hook at the end of every
 * EAP conversation). The reject cases are discriminating by construction: were the group not run, the conversation would be accepted. This file pins the behaviour, it does not
 * fix anything; the witness (a group that only calls eap) guards the lab.
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

async function converse(made: Awaited<ReturnType<typeof lab>>, peer: EapTlsPeerSession): Promise<'accept' | 'reject' | 'stuck'> {
  let reply = await made.client.executeCommand(`printf 'User-Name = "alice"\nEAP-Message = 0x${identityHex('alice')}\n' | radclient -x -r 1 -t 5 10.0.0.2 auth shared`);
  for (let round = 0; round < 200; round++) {
    if (reply.includes('Received Access-Accept')) return 'accept';
    if (reply.includes('Received Access-Reject')) return 'reject';
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

const SITES = `${DIR}/sites-available/default`;

async function withGroup(body: string) {
  const made = await lab(EAP('tls'));
  write(made.target, SITES, (vfsOf(made.target).readFile(SITES) ?? '').replace(/(\tauthenticate \{[\s\S]*?)\t\teap\n/, (_all, before) => `${before}\t\tAuth-Type eap {\n${body}\t\t}\n`));
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

describe('an Auth-Type eap group on an EAP-TLS conversation', () => {
  it('witness: a group that only calls eap authenticates the EAP-TLS conversation', async () => {
    const made = await withGroup('\t\t\teap\n');
    expect(await converse(made, tlsPeer(made.keys))).toBe('accept');
  });

  it('a reject after eap refuses a conversation the engine would accept', async () => {
    const made = await withGroup('\t\t\teap\n\t\t\treject\n');
    expect(await converse(made, tlsPeer(made.keys))).toBe('reject');
  });

  it('EAP-TLS: an update reply after eap is sent with the final Access-Accept', async () => {
    const made = await withGroup('\t\t\teap\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "tls group"\n\t\t\t}\n');
    expect(await converse(made, tlsPeer(made.keys))).toBe('accept');
    expect(made.lines.some((line) => line === 'Reply-Message = "tls group"')).toBe(true);
  });

  it('TTLS: a reject after eap refuses a tunnel the engine would accept', async () => {
    const made = await lab(EAP('ttls', '    default_eap_type = md5\n'));
    write(made.target, SITES, (vfsOf(made.target).readFile(SITES) ?? '').replace(/(\tauthenticate \{[\s\S]*?)\t\teap\n/, (_all, before) => `${before}\t\tAuth-Type eap {\n\t\t\teap\n\t\t\treject\n\t\t}\n`));
    await made.target.executeCommand('systemctl restart freeradius');
    const peer = new EapTlsPeerSession(null, made.keys.verifier, { eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wonderland') });
    expect(await converse(made, peer)).toBe('reject');
  });

  it('PEAP: a reject after eap refuses a tunnel the engine would accept', async () => {
    const made = await lab(EAP('peap'));
    write(made.target, SITES, (vfsOf(made.target).readFile(SITES) ?? '').replace(/(\tauthenticate \{[\s\S]*?)\t\teap\n/, (_all, before) => `${before}\t\tAuth-Type eap {\n\t\t\teap\n\t\t\treject\n\t\t}\n`));
    await made.target.executeCommand('systemctl restart freeradius');
    const peer = new EapTlsPeerSession(null, made.keys.verifier, { eapType: 'peap', innerAuth: new PeapMsChapV2InnerAuthPeer('alice', 'wonderland') });
    expect(await converse(made, peer)).toBe('reject');
  });
});
