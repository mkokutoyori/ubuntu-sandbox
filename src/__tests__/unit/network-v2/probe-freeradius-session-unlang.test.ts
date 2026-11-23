/*
 * Probe: the session section was a list of module names that only switched Simultaneous-Use on or off. Source of truth: FreeRADIUS v3.2.x
 * src/main/modules.c process_checksimul (the session section runs as a program; only an `ok` result counts: any other rcode lets the
 * login through; with `ok`, the login is denied when the sessions radutmp counted reach the maximum, simul_count being set by radutmp
 * itself, so a program that never reaches radutmp counts nothing), raddb/sites-available/default (session { radutmp }). The default site
 * is unchanged; an `if` around radutmp selects who is checked, a result other than ok (a reject after radutmp, an empty section)
 * lets the login in, and an unlang construct the simulator lacks is refused naming it.
 *
 * Discriminated with git stash on src: 3 of 6 fall before the fix; three pass either way and are named: the witness (the default session
 * section denies a second login), the empty section (it never denied) and the refusal of an unknown module (the same message on the base).
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

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';

async function lab(session: string) {
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
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland", Simultaneous-Use := 1\nbob Cleartext-Password := "builder", Simultaneous-Use := 1\n');
  write(target, SITE, (vfsOf(target).readFile(SITE) ?? '').replace(/\tsession \{[\s\S]*?\n\t\}\n/, `\tsession {\n${session}\t}\n`));
  const restarted = await target.executeCommand('systemctl restart freeradius');
  return { client, target, restarted };
}

const start = (user: string, session: string) =>
  `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "${session}"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient 10.0.0.2 acct shared`;
const login = (user: string, password: string) =>
  `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 9\\n' | radclient -r 1 10.0.0.2 auth shared`;

describe('unlang in the session section', () => {
  it('witness: the default session section denies a second login of a user at the maximum', async () => {
    const { client } = await lab('\t\tradutmp\n');
    await client.executeCommand(start('alice', 's1'));
    expect(await client.executeCommand(login('alice', 'wonderland'))).toContain('Received Access-Reject');
  });

  it('an if around radutmp chooses who is checked: alice is, bob is not', async () => {
    const { client } = await lab('\t\tif (&User-Name == "alice") {\n\t\t\tradutmp\n\t\t}\n');
    await client.executeCommand(start('alice', 's1'));
    await client.executeCommand(start('bob', 's2'));
    expect(await client.executeCommand(login('alice', 'wonderland'))).toContain('Received Access-Reject');
    expect(await client.executeCommand(login('bob', 'builder'))).toContain('Received Access-Accept');
  });

  it('a result other than ok lets the login through: a reject after radutmp permits', async () => {
    const { client } = await lab('\t\tradutmp\n\t\treject\n');
    await client.executeCommand(start('alice', 's1'));
    expect(await client.executeCommand(login('alice', 'wonderland'))).toContain('Received Access-Accept');
  });

  it('a program that never reaches radutmp counts nothing: the login is permitted', async () => {
    const { client } = await lab('\t\tif (&User-Name == "nobody") {\n\t\t\tradutmp\n\t\t}\n\t\tok\n');
    await client.executeCommand(start('alice', 's1'));
    expect(await client.executeCommand(login('alice', 'wonderland'))).toContain('Received Access-Accept');
  });

  it('an empty session section never denies', async () => {
    const { client } = await lab('');
    await client.executeCommand(start('alice', 's1'));
    expect(await client.executeCommand(login('alice', 'wonderland'))).toContain('Received Access-Accept');
  });

  it('refuses an unknown module and an unsupported unlang construct, naming them', async () => {
    expect((await lab('\t\tfrobnicate\n')).restarted).toContain('Failed to find module "frobnicate"');
    expect((await lab('\t\tmap &Reply-Message {\n\t\t}\n')).restarted).toContain('"map"');
  });
});
