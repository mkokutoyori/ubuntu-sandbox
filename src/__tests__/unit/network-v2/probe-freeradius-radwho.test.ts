/*
 * Probe: radwho did not exist, so the sessions the server holds open (what Simultaneous-Use counts) could not be listed. Source of
 * truth: FreeRADIUS v3.2.x src/main/radwho.c (getopt "d:D:fF:nN:sSipP:crRu:U:vZ", the two headers, the printf formats of the four
 * output shapes, proto() and dotime() with their ctime slicing, the name column taken from the passwd GECOS field up to the first
 * comma, the port indicator, -R printing RADIUS attributes with Acct-Session-Time from the record's time, -Z, usage on an unknown
 * option) and src/modules/rlm_radutmp/rlm_radutmp.c (what a record holds: login, NAS-Port, the last 8 characters of the session id,
 * NAS address, Framed-IP-Address, protocol P/S/T from Framed-Protocol, port type from NAS-Port-Type, Calling-Station-Id when
 * caller_id is on, the time minus Acct-Delay-Time). Not read from a file: the table is the server's own, so -F is refused.
 *
 * Found on the way: `usermod -c` was accepted and ignored (its value was even taken for the user name), so the GECOS field the name column
 * reads could not be set by the command that sets it; usermod now honours -c/--comment (last case).
 *
 * Discriminated with git stash on src: all 14 cases fall before the fix (the command does not exist, and usermod -c did nothing). The
 * lab is proved sound by the Simultaneous-Use probe, which feeds the same sessions through the same radclient and server.
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

const FRAMED = `printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s77"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 7\\nFramed-Protocol = PPP\\nFramed-IP-Address = 192.168.5.5\\nCalling-Station-Id = "aa-bb"\\n' | radclient 10.0.0.2 acct shared`;
const SHELL = `printf 'User-Name = "zed"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s88"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 9\\n' | radclient 10.0.0.2 acct shared`;
const HEADER = 'Login      Name\t      What  TTY  When      From\t    Location';
const HEADER_NO_NAME = 'Login      Port    What      When\t  From\t    Location';

async function labWithSession() {
  const { client, target } = await lab();
  await target.executeCommand('usermod -c "Alice Liddell,room 5" alice');
  await target.executeCommand('date -s "2030-01-02 10:00:00" >/dev/null');
  await client.executeCommand(FRAMED);
  return { client, target };
}

const who = async (target: LinuxServer, args = '') => (await target.executeCommand(`radwho ${args}`)).replace(/\n$/, '');

describe('radwho', () => {
  it('an empty table prints the header only', async () => {
    const { target } = await lab();
    expect(await who(target)).toBe(HEADER);
  });

  it('lists the session in the default format: full name from GECOS, PPP, port S7, day and time, NAS, framed address', async () => {
    const { target } = await labWithSession();
    expect(await who(target)).toBe(`${HEADER}\nalice      Alice Liddell     PPP   S7   Wed 10:00 10.0.0.1        192.168.5.5`);
  });

  it('-n drops the name column and uses the day-of-month form of the time', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-n')).toBe(`${HEADER_NO_NAME}\nalice      S7      PPP    Wed  2 10:00  10.0.0.1        192.168.5.5`);
  });

  it('-i shows the session id instead of the name, -c the caller id', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-i')).toBe(`${HEADER}\nalice      s77               PPP   S7   Wed 10:00 10.0.0.1        192.168.5.5`);
    expect(await who(target, '-c')).toBe(`${HEADER}\nalice      aa-bb             PPP   S7   Wed 10:00 10.0.0.1        192.168.5.5`);
  });

  it('-p adds the port type to the protocol column', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-p')).toContain(' PPP A ');
  });

  it('-r prints comma separated data without a header', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-r')).toBe('alice,Alice Liddell,PPP,S7,Wed 10:00,10.0.0.1,192.168.5.5');
  });

  it('-R prints the record as RADIUS attributes, with the session time since the start', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-R')).toMatch(/^User-Name = "alice"\nAcct-Session-Id = "s77"\nNAS-IP-Address = 10\.0\.0\.1\nNAS-Port = 7\nService-Type = Framed-User\nFramed-Protocol = PPP\nFramed-IP-Address = 192\.168\.5\.5\nAcct-Session-Time = \d+\nCalling-Station-Id = "aa-bb"\n?$/);
  });

  it('-R -Z adds Acct-Status-Type = Stop, and with -N alone asks the NAS to zap everything with an Accounting-Off', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-R -Z -u alice')).toContain('Acct-Session-Id = "s77"\nAcct-Status-Type = Stop\nNAS-IP-Address');
    expect(await who(target, '-R -Z -N 10.0.0.1')).toBe('Acct-Status-Type = Accounting-Off\nNAS-IP-Address = 10.0.0.1\nAcct-Delay-Time = 0');
  });

  it('-u matches a prefix without regard to case, -U with it, -P the NAS port, -N the NAS address', async () => {
    const { target } = await labWithSession();
    expect(await who(target, '-u ALI')).toContain('alice');
    expect(await who(target, '-U ALI')).toBe(HEADER);
    expect(await who(target, '-U ali')).toContain('alice');
    expect(await who(target, '-P 7')).toContain('alice');
    expect(await who(target, '-P 8')).toBe(HEADER);
    expect(await who(target, '-N 10.0.0.1')).toContain('alice');
    expect(await who(target, '-N 10.0.0.9')).toBe(HEADER);
  });

  it('a login with no passwd entry shows its own name, and -S hides sessions that are not SLIP or PPP', async () => {
    const { client, target } = await labWithSession();
    await client.executeCommand(SHELL);
    expect(await who(target, '-u zed')).toMatch(/^Login .*\nzed        zed               shell S9   /m);
    expect(await who(target, '-S')).not.toContain('zed');
    expect(await who(target, '-S')).toContain('alice');
  });

  it('a Stop removes the session from the table', async () => {
    const { client, target } = await labWithSession();
    await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Stop\\nAcct-Session-Id = "s77"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 7\\n' | radclient 10.0.0.2 acct shared`);
    expect(await who(target)).toBe(HEADER);
  });

  it('a session reported without NAS-Port, and the !root administrator, are not recorded', async () => {
    const { client, target } = await lab();
    await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "x1"\\n' | radclient 10.0.0.2 acct shared`);
    await client.executeCommand(`printf 'User-Name = "!root"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "x2"\\nNAS-Port = 1\\n' | radclient 10.0.0.2 acct shared`);
    expect(await who(target)).toBe(HEADER);
  });

  it('usermod -c sets the GECOS field that the name column reads', async () => {
    const { target } = await lab();
    await target.executeCommand('usermod -c "Zed Zee,room 9" alice');
    expect(await target.executeCommand('getent passwd alice')).toContain(':Zed Zee,room 9:');
  });

  it('an unknown option prints the usage of radwho.c and exits 1; -v prints the version; -F is refused naming why', async () => {
    const { target } = await lab();
    expect((await who(target, '-z')).split('\n')[0]).toBe('Usage: radwho [-d raddb] [-cfihnprRsSZ] [-N nas] [-P nas_port] [-u user] [-U user]');
    expect((await target.executeCommand('radwho -z >/dev/null 2>&1; echo $?')).trim()).toBe('1');
    expect(await who(target, '-v')).toBe('radwho version 3.2.11');
    expect(await who(target, '-F /var/log/freeradius/radutmp')).toContain('-F is not implemented in this simulator');
  });
});
