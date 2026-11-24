/*
 * Probe: `stats threads` was refused for want of worker threads. Source of truth: FreeRADIUS v3.2.x src/main/command.c (command_stats_threads prints
 * threads_active, threads_total, threads_max from thread_pool_thread_stats), src/main/threads.c (the `thread pool` section: start_servers 5, max_servers 32,
 * min_spare_servers 3, max_spare_servers 10, cleanup_delay 5, max_queue_size 65536 in 2-1048576; thread_pool_init clamps min/max spare to at least 1 and
 * max >= min, turns max_servers 0 into 256 and fatals when start_servers > max_servers; thread_pool_manage spawns spares up to min_spare and, once cleanup_delay
 * seconds have passed since the last spawn, reaps ONE idle thread per second down to max_spare). The simulator handles each request in the call that
 * receives it, so no worker is ever busy: threads_active is the true 0, and threads_total is what the pool manager settles on for an idle pool at the
 * time of the question. max_requests_per_server != 0 and auto_limit_acct = yes change nothing a simulated pool can show and are refused naming the limit.
 *
 * Discriminated with git stash on src/network: all 7 fall before the fix (the command was refused and the pool section was never read). The first case,
 * the defaults of the source, is the witness of the lab: its numbers are the ones thread_pool_init yields with no section.
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
import { CLIENTS_CONF_PATH, RADIUSD_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

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

const POOL = (body: string) => `thread pool {\n${body}}\n`;
async function poolLab(body: string) {
  const made = await lab(true);
  const conf = vfsOf(made.target).readFile(RADIUSD_CONF_PATH) ?? '';
  write(made.target, RADIUSD_CONF_PATH, `${conf}\n${POOL(body)}`);
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  return { ...made, restarted };
}
const SECONDS = (target: LinuxServer, seconds: number) => target.executeCommand(`date -s "$(date -d '+${seconds} seconds' '+%Y-%m-%d %H:%M:%S')" >/dev/null`);
const threads = async (target: LinuxServer) => {
  const text = (await ask(target, 'stats threads')).output;
  return { active: field(text, 'threads_active'), total: field(text, 'threads_total'), max: field(text, 'threads_max'), text };
};

describe('radmin stats threads', () => {
  it('prints the three lines with the defaults of the source: 0 active, 5 total, 32 max', async () => {
    const { target } = await lab(true);
    const { text, active, total, max } = await threads(target);
    expect(text.split('\n').map((line) => line.split(/\t+/)[0])).toEqual(['threads_active', 'threads_total', 'threads_max']);
    expect([active, total, max]).toEqual([0, 5, 32]);
  });

  it('reads start_servers and max_servers from the thread pool section', async () => {
    const { target, restarted } = await poolLab('  start_servers = 8\n  max_servers = 20\n');
    expect(restarted).not.toContain('Failed');
    expect(await threads(target)).toMatchObject({ active: 0, total: 8, max: 20 });
  });

  it('raises an idle pool to min_spare_servers', async () => {
    const { target } = await poolLab('  start_servers = 2\n  min_spare_servers = 6\n  max_spare_servers = 12\n');
    expect((await threads(target)).total).toBe(6);
  });

  it('reaps one spare per second, once cleanup_delay has passed, down to max_spare_servers', async () => {
    const { target } = await poolLab('  start_servers = 14\n  max_spare_servers = 10\n  cleanup_delay = 5\n');
    expect((await threads(target)).total).toBe(14);
    await SECONDS(target, 6);
    expect((await threads(target)).total).toBe(13);
    await SECONDS(target, 60);
    expect((await threads(target)).total).toBe(10);
  });

  it('turns max_servers = 0 into 256 and refuses a start_servers above max_servers in the words of the source', async () => {
    const zero = await poolLab('  max_servers = 0\n');
    expect((await threads(zero.target)).max).toBe(256);
    const above = await poolLab('  start_servers = 9\n  max_servers = 4\n');
    expect(above.restarted).toContain('start_servers (9) must be <= max_servers (4)');
  });

  it('refuses a max_queue_size out of range and the keys no simulated pool can show', async () => {
    expect((await poolLab('  max_queue_size = 1\n')).restarted).toContain('max_queue_size value must be in range 2-1048576');
    expect((await poolLab('  max_requests_per_server = 100\n')).restarted).toContain('"max_requests_per_server" is not implemented in this simulator');
    expect((await poolLab('  auto_limit_acct = yes\n')).restarted).toContain('"auto_limit_acct" is not implemented in this simulator');
  });

  it('refuses a key the pool does not have', async () => {
    expect((await poolLab('  worker_count = 3\n')).restarted).toContain('Unknown thread pool setting "worker_count"');
  });
});
