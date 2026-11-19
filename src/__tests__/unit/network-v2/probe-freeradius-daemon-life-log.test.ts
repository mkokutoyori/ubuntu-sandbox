/*
 * Probe: radius.log never carried the lines the daemon writes around its own life. Source of truth: FreeRADIUS v3.2.x
 * src/main/process.c event_status (INFO "Ready to process requests", once, only when not debugging), handle_signal_self (INFO
 * "Signalled to terminate" on SIGTERM, which is what systemctl stop sends), src/main/radiusd.c (INFO "Exiting normally"), and
 * src/main/log.c (": Info: " prefix). With -X the same messages go to stdout, never to the log file.
 *
 * Discriminated with git stash on src: 4 of 5 fall before the fix; the one that passes either way is the -X case (a non-regression: the log stays untouched). The restart case also pins a defect found
 * on the way: the unit's restart event ran a second stop+start after the start event already had, so a restart cycled the daemon twice.
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

async function lab(clientIp = '10.0.0.1') {
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
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const LOG = '/var/log/freeradius/radius.log';
const lines = (server: LinuxServer) => (vfsOf(server).readFile(LOG) ?? '').split('\n').filter((line) => line !== '').map((line) => line.replace(/^.*? : /, ''));

describe('daemon life in radius.log', () => {
  it('boot of the unit: Ready to process requests, once', async () => {
    const { target } = await lab();
    expect(lines(target)).toEqual(['Info: Ready to process requests']);
  });

  it('systemctl stop: Signalled to terminate, then Exiting normally', async () => {
    const { target } = await lab();
    await target.executeCommand('systemctl stop freeradius');
    expect(lines(target)).toEqual(['Info: Ready to process requests', 'Info: Signalled to terminate', 'Info: Exiting normally']);
  });

  it('systemctl restart: the old daemon exits, the new one is ready', async () => {
    const { target } = await lab();
    await target.executeCommand('systemctl restart freeradius');
    expect(lines(target)).toEqual([
      'Info: Ready to process requests', 'Info: Signalled to terminate', 'Info: Exiting normally', 'Info: Ready to process requests',
    ]);
  });

  it('a reload does not restart the daemon: no new line', async () => {
    const { target } = await lab();
    await target.executeCommand('systemctl reload freeradius');
    expect(lines(target)).toEqual(['Info: Ready to process requests']);
  });

  it('freeradius -X is debugging: nothing goes to the log file', async () => {
    const { target } = await lab();
    await target.executeCommand('systemctl stop freeradius');
    const before = lines(target).length;
    await target.executeCommand('freeradius -X');
    await target.getRadiusd().stop();
    expect(lines(target)).toHaveLength(before);
  });
});
