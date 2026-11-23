/*
 * Probe: the `eap` module was not configurable: EAP-TLS, PEAP and EAP-TTLS existed in the engine but only an in-process caller could
 * switch them on, and no conversation was traced. Source of truth: FreeRADIUS v3.2.x raddb/mods-available/eap (eap { default_eap_type
 * tls-config NAME { private_key_file certificate_file ca_file private_key_password fragment_size } tls { tls = NAME } peap { tls = NAME
 * default_eap_type } ttls { ... } }), src/modules/rlm_eap/eap.c and mem.c (the dispatch lines, as in the EAP-MD5 trace: "Peer sent packet
 * with method EAP TLS (13)" / "PEAP (25)" / "TTLS (21)", "Calling submodule eap_tls to process data", "Sending EAP Request (code 1) ID n
 * length n", "EAP session adding &reply:State = 0x...", "Previous EAP request found for state ..., released from the list", "Sending EAP
 * Success (code 3)", "Freeing handler"), libeap/eap_tls.c eaptls_verify (the fragment bookkeeping lines, quoted exactly: "(TLS) EAP Peer
 * says that the final record size will be N bytes", "Expecting N fragments", "Got first TLS fragment (N bytes).  Peer says more fragments
 * will follow", "Got additional fragment ...", "Got final fragment (N bytes) total N", "Got all data (N bytes)"). The `eap` section now
 * selects the method, reads the certificates and drives the real TLS 1.3 engine; keys the simulator does not honour are refused naming
 * them, and a zero `fragment_size` is refused; an EAP-Message longer than 253 bytes is split across repeated attributes (RFC 3579 section 3.1: the
 * server and radclient emit them, every reader concatenates them in order) and the default fragment_size is the real 1024. Debug levels above 2 (flags line, [eaptls process]) are not printed.
 *
 * Discriminated with git stash on src, in two steps. The eap module commit: 7 of the first 8 cases fall before it; the MD5 witness passes either
 * way. The RFC 3579 commit that follows (the fragmentation of an EAP-Message over repeated attributes, fragment_size defaulting to 1024):
 * 1 of the 10 cases falls before it, the default-fragment_size conversation; the fragment_size = 200 case (one attribute, nothing to split)
 * and the refusals pass either way and are named: they guard that the change did not move what already worked.
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

describe('the eap module: EAP-TLS, PEAP and TTLS', () => {
  it('witness: an eap section with default_eap_type = md5 and no TLS file starts, and the MD5 conversation still opens', async () => {
    const made = await lab(EAP('md5'));
    expect(made.started).not.toContain('Failed');
    const first = await made.client.executeCommand(`printf 'User-Name = "alice"\nEAP-Message = 0x${identityHex('alice')}\n' | radclient -x -r 1 -t 5 10.0.0.2 auth shared`);
    expect(first).toContain('Access-Challenge');
  });

  it('EAP-TLS: a client certificate issued by ca_file is accepted over the whole fragmented conversation', async () => {
    const made = await lab(EAP('tls'));
    expect(await converse(made, tlsPeer(made.keys))).toBe('accept');
  });

  it('EAP-TLS: a client certificate from another authority is rejected', async () => {
    const made = await lab(EAP('tls'));
    expect(await converse(made, tlsPeer(made.keys, 'stranger'))).toBe('reject');
    expect(made.lines).toContain('eap: Sending EAP Failure (code 4) ID ' + /ID (\d+) length 4/.exec(made.lines.find((line) => line.startsWith('eap: Sending EAP Failure')) ?? '')?.[1] + ' length 4');
  });

  it('the trace of the first round names the method submodule and the TLS Start it sends', async () => {
    const made = await lab(EAP('tls'));
    await made.client.executeCommand(`printf 'User-Name = "alice"\nEAP-Message = 0x${identityHex('alice')}\n' | radclient -x -r 1 -t 5 10.0.0.2 auth shared`);
    expect(made.lines).toContain('eap: Peer sent packet with method EAP Identity (1)');
    expect(made.lines).toContain('eap: Calling submodule eap_tls to process data');
    expect(made.lines).toContain('eap: Sending EAP Request (code 1) ID 1 length 6');
    expect(made.lines.some((line) => /^eap: EAP session adding &reply:State = 0x[0-9a-f]{16}$/.test(line))).toBe(true);
  });

  it('the later rounds trace the fragment bookkeeping of eaptls_verify and end with the success', async () => {
    const made = await lab(EAP('tls'));
    expect(await converse(made, tlsPeer(made.keys))).toBe('accept');
    expect(made.lines.some((line) => /^eap: Previous EAP request found for state 0x[0-9a-f]{16}, released from the list$/.test(line))).toBe(true);
    expect(made.lines).toContain('eap: Peer sent packet with method EAP TLS (13)');
    expect(made.lines.some((line) => /^\(TLS\) EAP Peer says that the final record size will be \d+ bytes$/.test(line))).toBe(true);
    expect(made.lines.some((line) => /^\(TLS\) EAP Got first TLS fragment \(\d+ bytes\)\.  Peer says more fragments will follow$/.test(line))).toBe(true);
    expect(made.lines.some((line) => /^\(TLS\) EAP Got final fragment \(\d+ bytes\) total \d+$/.test(line))).toBe(true);
    expect(made.lines.some((line) => /^eap: Sending EAP Success \(code 3\) ID \d+ length 4$/.test(line))).toBe(true);
    expect(made.lines).toContain('eap: Freeing handler');
  });

  it('TTLS: the tunnel carries a PAP password checked against the users file', async () => {
    const made = await lab(EAP('ttls', '    default_eap_type = md5\n'));
    const good = new EapTlsPeerSession(null, made.keys.verifier, { eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wonderland') });
    expect(await converse(made, good)).toBe('accept');
    expect(made.lines).toContain('eap: Peer sent packet with method TTLS (21)');
    expect(made.lines).toContain('eap: Calling submodule eap_ttls to process data');
    const bad = await lab(EAP('ttls', '    default_eap_type = md5\n'));
    expect(await converse(bad, new EapTlsPeerSession(null, bad.keys.verifier, { eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wrong') }))).toBe('reject');
  });

  it('PEAP: the tunnel carries an EAP-MD5 exchange checked against the users file', async () => {
    const made = await lab(EAP('peap', '    default_eap_type = md5\n'));
    const peer = new EapTlsPeerSession(null, made.keys.verifier, { eapType: 'peap', innerAuth: new PeapMd5InnerAuthPeer('alice', 'wonderland') });
    expect(await converse(made, peer)).toBe('accept');
    expect(made.lines).toContain('eap: Peer sent packet with method PEAP (25)');
    expect(made.lines).toContain('eap: Calling submodule eap_peap to process data');
  });

  it('with the default fragment_size the server fragments an EAP-Message over several attributes (RFC 3579 section 3.1) and the conversation still succeeds', async () => {
    mostPieces.value = 0;
    const made = await lab(EAP('tls'));
    expect(await converse(made, tlsPeer(made.keys))).toBe('accept');
    expect(mostPieces.value).toBeGreaterThanOrEqual(2);
  });

  it('a fragment_size that fits one attribute keeps every EAP-Message in a single attribute', async () => {
    mostPieces.value = 0;
    const made = await lab(EAP('tls', '', '    fragment_size = 200\n'));
    expect(await converse(made, tlsPeer(made.keys))).toBe('accept');
    expect(mostPieces.value).toBe(1);
  });

  it('refuses, in the words of the simulator, a setting it does not honour, a missing certificate and an invalid fragment size', async () => {
    expect((await lab(EAP('tls').replace('default_eap_type = tls', 'default_eap_type = tls\n  timer_expire = 60'))).started).toContain('The eap setting "timer_expire" is not implemented in this simulator');
    expect((await lab(EAP('tls', '', '    fragment_size = 0\n'))).started).toContain('Invalid value "0" for variable fragment_size');
    const made = await lab(EAP('tls'));
    write(made.target, `${DIR}/certs/server.pem`, '');
    expect(await made.target.executeCommand('systemctl restart freeradius')).toContain('Failed');
  });
});
