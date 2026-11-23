/*
 * Probe: `stats socket <ipaddr> <port>` and `stats queue` answered "not implemented". Source of truth: FreeRADIUS v3.2.x src/main/command.c
 * (command_stats_socket -> get_socket finds the listen section by address and port, "Must specify <ipaddr> <port> [udp|tcp]", "Failed
 * parsing IP address", "No such listen section"; command_print_stats with server = 0 prints the per-socket counters, the form that ends
 * with conflicts and unresponsive_child instead of timeouts; command_stats_queue prints queue_len_internal / proxy / auth / acct / detail
 * and queue_pps_in / out). Packets are counted per listener as they are per client and globally; the three statistics forms now share one
 * formatter (the client, home server and socket listings had two copies of the same lines). The simulator handles every request
 * synchronously in the receiving call, so there is no queue: its queue lengths and rates are the true value 0, not a placeholder.
 * `stats threads` has no meaning without worker threads and is still refused.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; the witness (stats client auth still answers) passes either way.
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



const ask = async (target: LinuxServer, command: string) => radmin(target, `-f ${SOCKET} -e "${command}"`);
const field = (text: string, name: string) => Number(new RegExp('^' + name + '\\t+(\\d+)$', 'm').exec(text)?.[1] ?? NaN);
const auth = (client: LinuxServer, port = '') => client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "x"\\n' | radclient -r 1 -t 1 10.0.0.2${port} auth shared`);
const acct = (client: LinuxServer, port = '') => client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s"\\nNAS-IP-Address = 10.0.0.1\\n' | radclient -r 1 -t 1 10.0.0.2${port} acct shared`);

describe('radmin stats socket and stats queue', () => {
  it('witness: stats client auth still answers', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'stats client auth')).output).toContain('requests');
  });

  it('stats socket counts what arrived on that listener, the authentication and the accounting socket apart', async () => {
    const { client, target } = await lab(true);
    await auth(client);
    await acct(client);
    await acct(client);
    const authSocket = (await ask(target, 'stats socket 10.0.0.2 1812')).output;
    const acctSocket = (await ask(target, 'stats socket 10.0.0.2 1813')).output;
    expect(field(authSocket, 'requests')).toBeGreaterThanOrEqual(1);
    expect(authSocket).toContain('accepts');
    expect(field(acctSocket, 'requests')).toBeGreaterThanOrEqual(2);
    expect(acctSocket).not.toContain('accepts');
    expect(field(acctSocket, 'requests')).toBeGreaterThan(field(authSocket, 'requests'));
  });

  it('stats socket ends with the per-socket form: conflicts and unresponsive_child, no timeouts', async () => {
    const { target } = await lab(true);
    const text = (await ask(target, 'stats socket 10.0.0.2 1812')).output;
    expect(text).toContain('conflicts');
    expect(text).toContain('unresponsive_child');
    expect(text).not.toContain('timeouts');
  });

  it('a packet of the wrong type is counted on the socket it arrived at', async () => {
    const { client, target } = await lab(true);
    await acct(client, ':1812');
    expect(field((await ask(target, 'stats socket 10.0.0.2 1812')).output, 'unknown_types')).toBeGreaterThanOrEqual(1);
    expect(field((await ask(target, 'stats socket 10.0.0.2 1813')).output, 'unknown_types')).toBe(0);
  });

  it('stats queue prints the seven queue lines, all 0 for a server that handles a request in the call that receives it', async () => {
    const { target } = await lab(true);
    const lines = (await ask(target, 'stats queue')).output.split('\n').map((line) => line.split(/\t+/));
    expect(lines.map((line) => line[0])).toEqual(['queue_len_internal', 'queue_len_proxy', 'queue_len_auth', 'queue_len_acct', 'queue_len_detail', 'queue_pps_in', 'queue_pps_out']);
    expect(lines.every((line) => line[1] === '0')).toBe(true);
  });

  it('refuses the missing arguments, a bad address and an unknown listener in the words of the source', async () => {
    const { target } = await lab(true);
    expect((await ask(target, 'stats socket')).output).toBe('ERROR: Must specify <ipaddr> <port> [udp|tcp]');
    expect((await ask(target, 'stats socket 10.0.0.2')).output).toBe('ERROR: Must specify <ipaddr> <port> [udp|tcp]');
    expect((await ask(target, 'stats socket nonsense 1812')).output).toBe('ERROR: Failed parsing IP address');
    expect((await ask(target, 'stats socket 10.0.0.2 9999')).output).toBe('ERROR: No such listen section');
  });
});
