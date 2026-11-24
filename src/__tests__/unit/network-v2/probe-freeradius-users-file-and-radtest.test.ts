/*
 * Probe: the freeradius `users` file was read as "one Cleartext-Password per line" and radtest printed an invented
 * identifier and never the reply. Source of truth: FreeRADIUS v3.2.x src/main/files.c (pairlist_read: check list on the
 * name line, indented reply list with trailing commas, DEFAULT, Fall-Through, `Auth-Type := Reject`), share/dictionary.rfc2865 /
 * rfc2868 (value names), src/main/radclient.c (-x output: "Sent <code> Id N from ..." / "Received <code> Id N ...",
 * "Expected Access-Accept got ..." on a Reject, exit 1 unless the expected code came back) and radtest.sh (usage, ppphint
 * -> Framed-Protocol = PPP, nasname -> NAS-IP-Address). The "(0)" prefix of the two REDEBUG lines is from memory of captured
 * radtest transcripts, the Reject marker text is from the source.
 *
 * Discriminated with git stash on src/network: 9 of 10 fall before the fix; one passes either way and is named: the witness
 * (a plain Cleartext-Password user is accepted).
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
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const USERS = [
  'alice Cleartext-Password := "wonderland"',
  '\tReply-Message = "Hello, alice",',
  '\tSession-Timeout = 3600,',
  '\tFramed-IP-Address = 10.9.8.7,',
  '\tService-Type = Framed-User',
  'mallory Cleartext-Password := "x", Auth-Type := Reject',
  'ppp-user Cleartext-Password := "p"',
  '\tReply-Message = "first",',
  '\tFall-Through = Yes',
  'DEFAULT Framed-Protocol == PPP, Cleartext-Password := "pppsecret"',
  '\tReply-Message = "ppp default"',
  'DEFAULT Cleartext-Password := "guest"',
  '\tReply-Message = "guest access"',
  '',
].join('\n');

function write(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

async function lab(users = USERS) {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, users);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

const radtest = (client: LinuxServer, args: string) => client.executeCommand(`radtest ${args} 10.0.0.2 0 shared`);

describe('freeradius users file and radtest', () => {
  it('witness: a plain Cleartext-Password user is accepted', async () => {
    const { client } = await lab();
    expect(await radtest(client, 'alice wonderland')).toContain('Received Access-Accept');
  });

  it('the Access-Accept carries the reply items of the entry, with names from the dictionary', async () => {
    const { client } = await lab();
    const out = await radtest(client, 'alice wonderland');
    expect(out).toContain('\tReply-Message = "Hello, alice"');
    expect(out).toContain('\tSession-Timeout = 3600');
    expect(out).toContain('\tFramed-IP-Address = 10.9.8.7');
    expect(out).toContain('\tService-Type = Framed-User');
  });

  it('prints the request the way radclient -x does, with the identifier that went on the wire', async () => {
    const { client } = await lab();
    const out = await radtest(client, 'alice wonderland');
    const sent = /Sent Access-Request Id (\d+) from 0\.0\.0\.0:\d+ to 10\.0\.0\.2:1812 length \d+/.exec(out);
    expect(sent).not.toBeNull();
    expect(out).toContain('\tUser-Name = "alice"');
    expect(out).toContain('\tNAS-IP-Address = 10.0.0.1');
    expect(out).toContain('\tNAS-Port = 0');
    expect(out).toContain('\tCleartext-Password = "wonderland"');
    expect(out).toMatch(new RegExp(`Received Access-Accept Id ${sent![1]} from 10\\.0\\.0\\.2:1812 to 10\\.0\\.0\\.1:\\d+ length \\d+`));
  });

  it('a wrong password is rejected and radclient says what it expected', async () => {
    const { client } = await lab();
    const out = await radtest(client, 'alice nope');
    expect(out).toContain('Received Access-Reject');
    expect(out).toContain('Expected Access-Accept got Access-Reject');
  });

  it('Auth-Type := Reject refuses a user whose password is right', async () => {
    const { client } = await lab();
    expect(await radtest(client, 'mallory x')).toContain('Received Access-Reject');
  });

  it('a DEFAULT entry answers a name no entry names', async () => {
    const { client } = await lab();
    const out = await radtest(client, 'zed guest');
    expect(out).toContain('Received Access-Accept');
    expect(out).toContain('\tReply-Message = "guest access"');
  });

  it('a ppphint reaches the server: the DEFAULT keyed on Framed-Protocol == PPP applies, and Fall-Through accumulates replies', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('radtest ppp-user pppsecret 10.0.0.2 0 shared 1');
    expect(out).toContain('\tFramed-Protocol = PPP');
    expect(out).toContain('Received Access-Accept');
    expect(out).toContain('\tReply-Message = "first"');
    expect(out).toContain('\tReply-Message = "ppp default"');
  });

  it('a user removed from the file and reloaded is no longer known', async () => {
    const { client, target } = await lab();
    expect(await radtest(client, 'alice wonderland')).toContain('Received Access-Accept');
    write(target, USERS_FILE_PATH, 'bob Cleartext-Password := "builder"\n');
    await target.executeCommand('systemctl reload freeradius');
    expect(await radtest(client, 'alice wonderland')).toContain('Access-Reject');
  });

  it('a reply item the dictionary does not know makes the reload fail, naming the file and line', async () => {
    const { target } = await lab();
    write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "w"\n\tFoo-Bar = 1\n');
    expect(await target.executeCommand('systemctl reload freeradius')).toContain(
      `${USERS_FILE_PATH}[2]: Parse error (reply) for entry alice: Unknown attribute "Foo-Bar"`);
  });

  it('radtest prints the usage of radtest.sh when called short', async () => {
    const { client } = await lab();
    expect(await client.executeCommand('radtest alice')).toContain('Usage: radtest [OPTIONS] user passwd radius-server[:port] nas-port-number secret [ppphint] [nasname]');
  });
});
