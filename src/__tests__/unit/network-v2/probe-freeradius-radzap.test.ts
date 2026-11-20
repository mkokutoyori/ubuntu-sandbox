/*
 * Probe: radzap was absent, and the pieces it needs were missing from the shell. Source of truth: FreeRADIUS v3.2.x
 * src/main/radzap (a /bin/sh script: `radwho -ZR $OPTS $NAS_IP_ADDR $NAS_PORT $USER_NAME | radclient $DEBUG $OPTS -f - $SERVER acct
 * $SECRET`; usage text; exactly two positional arguments), src/main/radclient.c (`-f -` reads stdin) and radwho.c (-Z adds
 * Acct-Status-Type = Stop). The script is shipped verbatim in /usr/bin/radzap and runs on the simulator's shell: this needed a
 * command on the PATH that is a script (`#!`) to be run as one, in the async dispatcher (a network command inside it must be
 * awaited), and `radclient -f -` to read the pipe. The Stop reaches the server as a real Accounting-Request and the server's own
 * journal drops the session.
 *
 * Discriminated with git stash on src: 5 of 7 fall before the fix; two pass either way and are named: the witness (the session is visible to radwho
 * after a Start) and the negative case (a file on the PATH without the exec bit is not run).
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

async function lab() {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\nclient localhost {\n  ipaddr = 127.0.0.1\n  secret = testing123\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\nbob Cleartext-Password := "builder"\n');
  await target.executeCommand('systemctl restart freeradius');
  return { client, target };
}

const start = (user: string, session: string, port: number) =>
  `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "${session}"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = ${port}\\n' | radclient 10.0.0.2 acct shared`;

describe('radzap', () => {
  it('witness: radwho sees the sessions a Start opened', async () => {
    const { client, target } = await lab();
    await client.executeCommand(start('alice', 's1', 1));
    await client.executeCommand(start('bob', 's2', 2));
    const who = await target.executeCommand('radwho');
    expect(who).toContain('alice');
    expect(who).toContain('bob');
  });

  it('radzap -u removes that user from the session table through a real Accounting Stop', async () => {
    const { client, target } = await lab();
    await client.executeCommand(start('alice', 's1', 1));
    await client.executeCommand(start('bob', 's2', 2));
    await target.executeCommand('radzap -u alice 127.0.0.1 testing123');
    const who = await target.executeCommand('radwho');
    expect(who).not.toContain('alice');
    expect(who).toContain('bob');
  });

  it('radzap -N zaps every session of that NAS', async () => {
    const { client, target } = await lab();
    await client.executeCommand(start('alice', 's1', 1));
    await client.executeCommand(start('bob', 's2', 2));
    await target.executeCommand('radzap -N 10.0.0.1 127.0.0.1 testing123');
    const who = await target.executeCommand('radwho');
    expect(who).not.toContain('alice');
    expect(who).not.toContain('bob');
  });

  it('prints the source usage and exits 1 without the two positional arguments', async () => {
    const { target } = await lab();
    const output = await target.executeCommand('radzap -u alice 127.0.0.1; echo rc=$?');
    expect(output).toContain('Usage: radzap [options] server[:port] secret');
    expect(output).toContain('rc=1');
  });

  it('radclient -f - reads the packets from the pipe', async () => {
    const { client } = await lab();
    const output = await client.executeCommand(`printf 'User-Name = "bob"\\nUser-Password = "builder"\\n' | radclient -f - 10.0.0.2 auth shared`);
    expect(output).toContain('Access-Accept');
  });

  it('a script placed on the PATH runs by its bare name, and a network command inside it is awaited', async () => {
    const { client, target } = await lab();
    await client.executeCommand(start('bob', 's2', 2));
    write(target, '/usr/local/bin/whois-bob', '#!/bin/sh\necho marker-$(radwho | grep -c bob)\n');
    vfsOf(target).chmod('/usr/local/bin/whois-bob', 0o755);
    expect(await target.executeCommand('whois-bob')).toBe('marker-1');
  });

  it('a file on the PATH without the exec bit is not run', async () => {
    const { target } = await lab();
    write(target, '/usr/local/bin/noexec', '#!/bin/sh\necho ran\n');
    expect(await target.executeCommand('noexec')).not.toContain('ran');
  });
});
