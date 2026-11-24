/*
 * Probe: the session-state list of unlang. FreeRADIUS v3.2.x (src/main/process.c, request_data: the session-state list is saved with the Access-Challenge under
 * its State and restored into the next Access-Request that carries it; doc/unlang/list.adoc, raddb/sites-available/default). It was refused as an unknown list;
 * it is now a list of the request context readable and writable by update, conditions and foreach, kept across the rounds of one conversation and dropped when
 * the conversation ends. The conversation is a real EAP-TLS exchange through radclient, as in the trace probe.
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (a list written and read in the same request) fails too on the base because the list
 * is refused, so it is the lab's soundness check and the isolation case is the one that passes either way: a second conversation never sees the first one's state.
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



const fresh = (made: Awaited<ReturnType<typeof lab>>) =>
  new EapTlsPeerSession(made.keys.client.cert, made.keys.verifier, { clientPrivateKey: made.keys.client.privateKey });

const SITE_FILE = '/etc/freeradius/3.0/sites-available/default';

async function withAuthorize(block: string) {
  const made = await lab(EAP('tls'));
  write(made.target, SITE_FILE, (vfsOf(made.target).readFile(SITE_FILE) ?? '').replace('\t\tfiles\n', `\t\tfiles\n${block}`));
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  return { ...made, restarted };
}

const REMEMBER = [
  '\t\tif (&session-state:Marker == "round-one") {',
  '\t\t\tupdate control {',
  '\t\t\t\tTmp-Restored := "yes"',
  '\t\t\t}',
  '\t\t}',
  '\t\telse {',
  '\t\t\tupdate session-state {',
  '\t\t\t\tMarker := "round-one"',
  '\t\t\t}',
  '\t\t}',
  '',
].join('\n');

const restoredCount = (lines: string[]) => lines.filter((line) => line.includes('session-state:Marker') && line.includes('TRUE')).length;

describe('the session-state list', () => {
  it('witness: the list is accepted and written in the request that creates it', async () => {
    const made = await withAuthorize(REMEMBER);
    expect(made.restarted).not.toContain('Failed');
    const peer = fresh(made);
    expect(await converse(made, peer)).toBe('accept');
  });

  it('what a round writes is read by the next round of the same conversation', async () => {
    const made = await withAuthorize(REMEMBER);
    expect(made.restarted).not.toContain('Failed');
    const peer = fresh(made);
    await converse(made, peer);
    expect(restoredCount(made.lines)).toBeGreaterThan(0);
  });

  it('a second conversation starts with an empty list', async () => {
    const made = await withAuthorize(REMEMBER);
    const first = fresh(made);
    await converse(made, first);
    const afterFirst = restoredCount(made.lines);
    const second = fresh(made);
    await converse(made, second);
    expect(restoredCount(made.lines) - afterFirst).toBe(afterFirst);
  });

  it('a name the dictionary does not know is accepted in session-state, as in control', async () => {
    const made = await withAuthorize('\t\tupdate session-state {\n\t\t\tMy-Own-Marker := "x"\n\t\t}\n');
    expect(made.restarted).not.toContain('Failed');
  });
});
