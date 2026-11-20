/*
 * Probe: the `-X` trace of an EAP-MD5 conversation was absent (only the packets in and out). Source of truth: FreeRADIUS v3.2.x
 * src/modules/rlm_eap/eap.c (the strings, quoted exactly: "Peer sent EAP Response (code 2) ID n length n", "EAP-Identity reply,
 * returning 'ok' so we can short-circuit the rest of authorize", "No EAP Start, assuming it's an on-going EAP conversation", "Peer sent
 * packet with method EAP Identity (1)" / "EAP MD5 (4)", "Calling submodule eap_md5 to process data", "Sending EAP Request (code 1) ID n
 * length n", "Sending EAP Success (code 3)", "Freeing handler"), mem.c ("EAP session adding &reply:State = 0x...", "Previous EAP request
 * found for state 0x..., released from the list"), types/rlm_eap_md5 ("Issuing MD5 Challenge"), and rad_authenticate: the eap module
 * sets Auth-Type = eap and the whole authenticate section runs ("Found Auth-Type = eap", "# Executing group from file ...",
 * "authenticate {"). The order is read from the sources; no real -X capture of an EAP exchange was reachable. EAP-TLS, PEAP and
 * TTLS conversations are not traced (TODO.md).
 *
 * Discriminated with git stash on src: 6 of 7 fall before the fix, the witness included: `radclient auth` refused a packet with an EAP-Message
 * and no password ("Packet is missing User-Name or a password attribute"), and its `0x` octets value was not decoded, so the exchange
 * could not even be sent. The one passing either way is the absence of a false 'No Auth-Type found', vacuous on the base where nothing
 * was printed; it guards the after-fix trace.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { computeEapMd5Response, eapPacketFromWireHex } from '@/network/radius/eap';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab(clientIp = '10.0.0.1', users = 'alice Cleartext-Password := "wonderland"\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, `client lab {\n  ipaddr = ${clientIp}\n  secret = shared\n}\n`);
  write(target, USERS_FILE_PATH, users);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const SITES = '/etc/freeradius/3.0/sites-available/default';
const hexOf = (output: string, name: string) => Array.from(output.matchAll(new RegExp(`${name} = 0x([0-9a-f]+)`, 'g'))).pop()?.[1] ?? '';
const identityHex = (name: string) => `020000${(5 + name.length).toString(16).padStart(2, '0')}01${Buffer.from(name).toString('hex')}`;

async function exchange(password: string) {
  const made = await lab();
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '')));
  const first = await made.client.executeCommand(`printf 'User-Name = "alice"\\nEAP-Message = 0x${identityHex('alice')}\\n' | radclient -x -r 1 10.0.0.2 auth shared`);
  const request = eapPacketFromWireHex(hexOf(first, 'EAP-Message'));
  const state = hexOf(first, 'State');
  let second = '';
  if (request?.eapType === 'md5-challenge' && request.md5Challenge !== undefined) {
    const response = computeEapMd5Response(request.identifier, password, request.md5Challenge);
    const body = `02${request.identifier.toString(16).padStart(2, '0')}001604 10${response}`.replace(' ', '');
    second = await made.client.executeCommand(`printf 'User-Name = "alice"\\nState = 0x${state}\\nEAP-Message = 0x${body}\\n' | radclient -x -r 1 10.0.0.2 auth shared; echo rc=$?`);
  }
  return { ...made, lines, first, second, state };
}

describe('the -X trace of an EAP-MD5 conversation', () => {
  it('witness: the right password is accepted and the wrong one rejected', async () => {
    expect((await exchange('wonderland')).second).toContain('Access-Accept');
    expect((await exchange('wrong')).second).toContain('Access-Reject');
  });

  it('authorize recognises the Identity response and short-circuits', async () => {
    const { lines } = await exchange('wonderland');
    const text = lines.map((line) => line.trim());
    expect(text.some((line) => /^eap: Peer sent EAP Response \(code 2\) ID \d+ length \d+$/.test(line))).toBe(true);
    expect(text).toContain("eap: EAP-Identity reply, returning 'ok' so we can short-circuit the rest of authorize");
    expect(text).toContain('[eap] = ok');
  });

  it('runs the authenticate section and issues the MD5 challenge with the state it stores', async () => {
    const { lines, state } = await exchange('wonderland');
    const text = lines.map((line) => line.trim());
    expect(text).toContain('Found Auth-Type = eap');
    expect(text).toContain('authenticate {');
    expect(text).toContain('eap: Peer sent packet with method EAP Identity (1)');
    expect(text).toContain('eap_md5: Issuing MD5 Challenge');
    expect(text).toContain('eap: Sending EAP Request (code 1) ID 1 length 22');
    expect(text).toContain(`eap: EAP session adding &reply:State = 0x${state.slice(0, 16)}`);
    expect(text).toContain('[eap] = handled');
    expect(text).toContain('} # authenticate = handled');
  });

  it('the second round announces an on-going conversation and the state it releases', async () => {
    const { lines, state } = await exchange('wonderland');
    const text = lines.map((line) => line.trim());
    expect(text).toContain("eap: No EAP Start, assuming it's an on-going EAP conversation");
    expect(text).toContain('[eap] = updated');
    expect(text).toContain(`eap: Previous EAP request found for state 0x${state.slice(0, 16)}, released from the list`);
    expect(text).toContain('eap: Peer sent packet with method EAP MD5 (4)');
  });

  it('a success ends with EAP Success, the handler freed and an ok result', async () => {
    const { lines } = await exchange('wonderland');
    const text = lines.map((line) => line.trim());
    expect(text.some((line) => /^eap: Sending EAP Success \(code 3\) ID \d+ length 4$/.test(line))).toBe(true);
    expect(text).toContain('eap: Freeing handler');
    expect(text).toContain('} # authenticate = ok');
  });

  it('a wrong password ends with EAP Failure, a reject and the failure line', async () => {
    const { lines } = await exchange('wrong');
    const text = lines.map((line) => line.trim());
    expect(text.some((line) => /^eap: Sending EAP Failure \(code 4\) ID \d+ length 4$/.test(line))).toBe(true);
    expect(text).toContain('} # authenticate = reject');
    expect(text).toContain('Failed to authenticate the user');
  });

  it('never claims that no Auth-Type was found', async () => {
    const { lines } = await exchange('wonderland');
    expect(lines.some((line) => line.includes('No Auth-Type found'))).toBe(false);
  });
});



