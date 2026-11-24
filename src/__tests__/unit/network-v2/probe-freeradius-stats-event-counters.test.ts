/*
 * Probe: the statistics counters dup, invalid, malformed, unknown_types were kept at 0 (invalid, malformed and unknown_types had no
 * event behind them; only dup was counted). Source of truth: FreeRADIUS v3.2.x src/main/listen.c (auth_socket_recv / acct_socket_recv:
 * a datagram shorter than the RADIUS header, or one rad_recv refuses, is total_malformed_requests; a packet from an address that is
 * no client is total_invalid_requests; a code that is neither Access-Request / Status-Server on the auth port nor Accounting-Request /
 * Status-Server on the accounting port, or a Status-Server while status_server is off, is total_unknown_types (the last one is counted but not probed here); each is counted in
 * the global statistics only, together with total_requests), command.c (`stats client auth|acct` with no client prints the global ones).
 * dropped and no_records still have no event here (no request queue, no detail reader) and stay 0; see TODO.md.
 *
 * Discriminated with git stash on src: 4 of 5 fall before the fix; the witness (a good request counts one request and no error counter)
 * passes either way and is named.
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
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\nclient net {\n  ipaddr = 192.168.0.0/16\n  secret = other\n  shortname = lan\n}\n');
  if (enableControl) write(target, `${ENABLED}/control-socket`, control);
  const restarted = await target.executeCommand('systemctl restart freeradius');
  return { client, target, restarted };
}

const radmin = async (server: LinuxServer, args: string) => {
  const output = (await server.executeCommand(`radmin ${args}`)).trim();
  const code = (await server.executeCommand('echo $?')).trim();
  return { output, code };
};



const stats = async (target: LinuxServer, kind: string) => (await radmin(target, '-f ' + SOCKET + ' -e "stats client ' + kind + '"')).output;
const field = (text: string, name: string) => Number(new RegExp('^' + name + '\\t+(\\d+)$', 'm').exec(text)?.[1] ?? NaN);
const send = (command: string) => command;
const same = (text: string, name: string) => { expect(field(text, name)).toBeGreaterThanOrEqual(1); expect(field(text, 'requests')).toBe(field(text, name)); };

describe('radmin stats: the counters that had no event', () => {
  it('witness: a good request counts one request and no error counter', async () => {
    const { client, target } = await lab(true);
    await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "x"\\n' | radclient -r 1 -t 1 10.0.0.2 auth shared`);
    const text = await stats(target, 'auth');
    expect(field(text, 'requests')).toBe(1);
    for (const name of ['invalid', 'malformed', 'unknown_types', 'dup']) expect(field(text, name)).toBe(0);
  });

  it('an Accounting-Request sent to the authentication port is an unknown type', async () => {
    const { client, target } = await lab(true);
    await client.executeCommand(send(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s"\\n' | radclient -r 1 -t 1 10.0.0.2:1812 acct shared`));
    const text = await stats(target, 'auth');
    same(text, 'unknown_types');
  });

  it('an Access-Request sent to the accounting port is an unknown type of the accounting statistics', async () => {
    const { client, target } = await lab(true);
    await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "x"\\n' | radclient -r 1 -t 1 10.0.0.2:1813 auth shared`);
    same(await stats(target, 'acct'), 'unknown_types');
    expect(field(await stats(target, 'auth'), 'unknown_types')).toBe(0);
  });

  it('a request from an address that is no client is invalid, in the global statistics only', async () => {
    const { client, target } = await lab(true);
    write(target, CLIENTS_CONF_PATH, 'client other {\n  ipaddr = 10.0.0.77\n  secret = shared\n}\n');
    await target.executeCommand('systemctl restart freeradius');
    await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "x"\\n' | radclient -r 1 -t 1 10.0.0.2 auth shared`);
    const text = await stats(target, 'auth');
    same(text, 'invalid');
  });

  it('a datagram that is not RADIUS, sent to the port, is malformed', async () => {
    const { client, target } = await lab(true);
    await client.executeCommand('echo hello | nc -u -w1 10.0.0.2 1812');
    same(await stats(target, 'auth'), 'malformed');
  });
});
