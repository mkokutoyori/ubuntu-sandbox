/*
 * Probe: `show version` and `show module status <name>` answered "not implemented", and `show client list verbose` printed `proto = *`
 * for every client whatever its section said (a client written `proto = tcp` or left UDP looked dual). Source of truth: FreeRADIUS
 * v3.2.x src/main/command.c (command_show_version prints radiusd_version; command_show_module_status: "No module name was given" /
 * "No such module '%s'", `alive` for a module not forced to a code; command_show_clients prints udp, tcp or * from client->proto) and
 * radiusd.c (radiusd_version = "FreeRADIUS Version X, for host H" plus a build date that a reproducible build omits: the same line that
 * `freeradius -v` prints in this simulator, now one constant).
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; two pass either way and are named: the control (the client block is
 * printed) and the proto = * section (base printed * for every client, so a dual client was already right).
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
import { CLIENTS_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const ENABLED = '/etc/freeradius/3.0/sites-enabled';
const SOCKET = '/var/run/freeradius/freeradius.sock';

async function lab(enableControl: boolean, control = 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n}\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  proto = tcp\n  secret = shared\n}\nclient net {\n  ipaddr = 192.168.0.0/16\n  secret = other\n  shortname = lan\n}\n');
  if (enableControl) write(target, `${ENABLED}/control-socket`, control);
  const restarted = await target.executeCommand('systemctl restart freeradius');
  return { client, target, restarted };
}

const radmin = async (server: LinuxServer, args: string) => {
  const output = (await server.executeCommand(`radmin ${args}`)).trim();
  const code = (await server.executeCommand('echo $?')).trim();
  return { output, code };
};


describe('radmin: version, module status, client protocol', () => {
  it('control: show client list verbose still prints the client block', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client list verbose"')).output).toContain('client lab {');
  });

  it('show version prints the one version line of the daemon', async () => {
    const { target } = await lab(true);
    const line = (await radmin(target, '-f ' + SOCKET + ' -e "show version"')).output;
    expect(line).toBe('FreeRADIUS Version 3.2.11, for host x86_64-pc-linux-gnu');
    expect((await target.executeCommand('freeradius -v')).split('\n')[0]).toBe('freeradius: ' + line);
  });

  it('show module status names a loaded module alive, and refuses an unknown one and a missing name in the words of the source', async () => {
    const { target } = await lab(true);
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show module status detail"')).output).toBe('alive');
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show module status nosuch"')).output).toBe("ERROR: No such module 'nosuch'");
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show module status"')).output).toBe('ERROR: No module name was given');
  });

  it('show client list verbose prints the protocol of each client section: tcp for proto = tcp, udp when none is written', async () => {
    const { target } = await lab(true);
    const text = (await radmin(target, '-f ' + SOCKET + ' -e "show client list verbose"')).output;
    const blocks = text.split('}').filter((block) => block.includes('client '));
    expect(blocks.find((block) => block.includes('client lab'))).toContain('\tproto = tcp');
    expect(blocks.find((block) => block.includes('client net'))).toContain('\tproto = udp');
  });

  it('a proto = * section prints *', async () => {
    const { target } = await lab(true);
    write(target, CLIENTS_CONF_PATH, 'client any {\n  ipaddr = 10.0.0.1\n  proto = *\n  secret = shared\n}\n');
    await target.executeCommand('systemctl restart freeradius');
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client list verbose"')).output).toContain('\tproto = *');
  });

  it('a proto = tls section prints tcp, as the source does for IPPROTO_TCP', async () => {
    const { target } = await lab(true);
    write(target, CLIENTS_CONF_PATH, 'client secure {\n  ipaddr = 10.0.0.1\n  proto = tls\n}\n');
    await target.executeCommand('systemctl restart freeradius');
    expect((await radmin(target, '-f ' + SOCKET + ' -e "show client list verbose"')).output).toContain('\tproto = tcp');
  });
});
