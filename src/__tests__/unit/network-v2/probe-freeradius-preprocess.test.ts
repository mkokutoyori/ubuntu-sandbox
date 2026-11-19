/*
 * Probe: Hint and Huntgroup-Name were accepted in the users file and could never be true, and the hints and huntgroups files did not
 * exist. Source of truth: FreeRADIUS v3.2.x src/modules/rlm_preprocess/rlm_preprocess.c (mod_authorize: hints_setup for the first
 * entry whose name is DEFAULT or the user name and whose check items match, adding its reply items to the REQUEST and skipping
 * Strip-User-Name and Fall-Through, Fall-Through = Yes reading on; huntgroup_access: the FIRST entry whose check items match names the
 * huntgroup, its indented lines are alternatives of which one must match or the request is rejected (RLM_MODULE_REJECT), a match
 * adds Huntgroup-Name; add_nas_attr), raddb/mods-available/preprocess and raddb/mods-config/preprocess/hints and huntgroups (the
 * shipped hints key on Suffix, which the realm module sets later, so they match nothing by default; modconfdir = ${confdir}/mods-config
 * in radiusd.conf), the pairlist_read error "Couldn't open %s for reading". A Group check is the rlm_unix comparison against the
 * machine's own groups. The files are read with the one pair-list reader of the users file.
 *
 * Discriminated with git stash on src: 7 of 9 fall before the fix; two pass either way and are named: the witness (a default install
 * still accepts a login, the shipped hints and huntgroups changing nothing) and the hints entry named after another user (a reject,
 * which ignoring the hints file also gives).
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

const PRE = '/etc/freeradius/3.0/mods-config/preprocess';
const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient 10.0.0.2 auth shared`;
const ZED = `printf 'User-Name = "zed"\\nUser-Password = "pppsecret"\\n' | radclient 10.0.0.2 auth shared`;

async function labWith(files: { users: string; hints?: string; huntgroups?: string }) {
  const made = await lab('10.0.0.1', files.users);
  if (files.hints !== undefined) write(made.target, `${PRE}/hints`, files.hints);
  if (files.huntgroups !== undefined) write(made.target, `${PRE}/huntgroups`, files.huntgroups);
  await made.target.executeCommand('systemctl reload freeradius');
  return made;
}

const USERS = 'alice Cleartext-Password := "wonderland"\nDEFAULT Hint == "PPP", Cleartext-Password := "pppsecret"\n\tReply-Message = "ppp"\n';
const HINTS = 'DEFAULT NAS-IP-Address == 10.0.0.1\n\tHint = "PPP"\n';

describe('the preprocess module: hints and huntgroups', () => {
  it('witness: a default install accepts a login, the shipped hints and huntgroups changing nothing', async () => {
    const { client } = await lab();
    expect(await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "alice"\\n' | radclient 10.0.0.2 auth shared`)).toMatch(/Received Access-(Accept|Reject)/);
    const { client: other } = await labWith({ users: USERS });
    expect(await other.executeCommand(ALICE)).toContain('Received Access-Accept');
  });

  it('the shipped files are where radiusd.conf says: the module in mods-enabled, the lists in mods-config/preprocess', async () => {
    const { target } = await lab();
    expect(await target.executeCommand('cat /etc/freeradius/3.0/mods-enabled/preprocess')).toContain('hints = ${modconfdir}/preprocess/hints');
    expect(await target.executeCommand(`grep -c "Suffix == " ${PRE}/hints`)).toContain('2');
    expect(await target.executeCommand(`ls ${PRE}`)).toContain('huntgroups');
  });

  it('a hint added by the hints file is what the users file tests: without it the DEFAULT entry does not apply', async () => {
    const without = await labWith({ users: USERS });
    expect(await without.client.executeCommand(ZED)).toContain('Received Access-Reject');
    const withHint = await labWith({ users: USERS, hints: HINTS });
    expect(await withHint.client.executeCommand(ZED)).toContain('Received Access-Accept');
  });

  it('a hints entry named after the user applies to that user only', async () => {
    const { client } = await labWith({ users: USERS, hints: 'alice NAS-IP-Address == 10.0.0.1\n\tHint = "PPP"\n' });
    expect(await client.executeCommand(ZED)).toContain('Received Access-Reject');
  });

  it('Fall-Through = Yes keeps reading hints entries, and a hint of the first still counts', async () => {
    const { client } = await labWith({
      users: 'DEFAULT Hint == "PPP", Service-Type == Framed-User, Cleartext-Password := "pppsecret"\n',
      hints: 'DEFAULT NAS-IP-Address == 10.0.0.1\n\tHint = "PPP",\n\tFall-Through = Yes\n\nDEFAULT NAS-IP-Address == 10.0.0.1\n\tService-Type = Framed-User\n',
    });
    expect(await client.executeCommand(ZED)).toContain('Received Access-Accept');
  });

  it('a huntgroup names the NAS, the users file tests Huntgroup-Name', async () => {
    const users = 'DEFAULT Huntgroup-Name == "lab", Cleartext-Password := "pppsecret"\n';
    const named = await labWith({ users, huntgroups: 'lab\tNAS-IP-Address == 10.0.0.1\n' });
    expect(await named.client.executeCommand(ZED)).toContain('Received Access-Accept');
    const other = await labWith({ users, huntgroups: 'lab\tNAS-IP-Address == 10.0.0.9\n' });
    expect(await other.client.executeCommand(ZED)).toContain('Received Access-Reject');
  });

  it('the indented lines restrict the huntgroup: one of them must match, or the request is rejected with the right password', async () => {
    const huntgroups = 'lab\tNAS-IP-Address == 10.0.0.1\n\tUser-Name == alice\n';
    const { client } = await labWith({ users: 'alice Cleartext-Password := "wonderland"\nzed Cleartext-Password := "pppsecret"\n', huntgroups });
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Accept');
    expect(await client.executeCommand(ZED)).toContain('Received Access-Reject');
  });

  it('a Group restriction reads the machine groups: alice is let in once she is a member', async () => {
    const huntgroups = 'lab\tNAS-IP-Address == 10.0.0.1\n\tGroup == staff\n';
    const { client, target } = await labWith({ users: 'alice Cleartext-Password := "wonderland"\n', huntgroups });
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Reject');
    await target.executeCommand('groupadd staff; usermod -aG staff alice');
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Accept');
  });

  it('only the first huntgroup that matches is considered, and a hints or huntgroups file that is missing stops the daemon', async () => {
    const { client, target } = await labWith({
      users: 'alice Cleartext-Password := "wonderland"\n',
      huntgroups: 'first\tNAS-IP-Address == 10.0.0.1\n\tUser-Name == nobody\n\nsecond\tNAS-IP-Address == 10.0.0.1\n',
    });
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Reject');
    await target.executeCommand(`rm ${PRE}/hints`);
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: false, error: `Couldn't open ${PRE}/hints for reading: No such file or directory` });
  });
});
