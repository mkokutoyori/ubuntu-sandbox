/*
 * Probe: the statistics a status listener serves. Source of truth: FreeRADIUS v3.2.x src/main/stats.c (request_stats_reply: statistics only on a status
 * listener, FreeRADIUS-Statistics-Type is a bit mask, 0x01 authentication and 0x02 accounting, masked out when 0xe0 asks for a client, server or home server;
 * request_stats_addvp walks authvp / acctvp in order) and share/dictionary.freeradius (vendor 11344, attribute numbers 127 and 128-137, 148-154, 191, 192, the value
 * names of FreeRADIUS-Statistics-Type). The simulator's dictionary had no FreeRADIUS attribute, so a Status-Server answered only a Message-Authenticator.
 * The counters are the ones radmin already reads (`stats auth`): one store, two views. Not served: the elapsed histogram (vendor attribute 198 is a TLV in 3.x), the
 * proxy counters (flags 4 and 8), internal, client, server and home-server statistics.
 *
 * Discriminated with git stash on src/network: 4 of 5 fall before the fix. The witness (a Status-Server without the attribute is still answered with no counter) passes either way.
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
const ENABLED = '/etc/freeradius/3.0/sites-enabled';
const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n'`;
const ask = (flag: string) => `printf 'Message-Authenticator = 0x00\\n${flag === '' ? '' : `FreeRADIUS-Statistics-Type = ${flag}\\n`}'`;

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
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  await target.executeCommand(`ln -s ../sites-available/status ${ENABLED}/status`);
  await target.executeCommand('systemctl restart freeradius');
  await client.executeCommand(`${ALICE} | radclient 10.0.0.2 auth shared`);
  await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wrong"\\n' | radclient 10.0.0.2 auth shared`);
  return { client, target };
}

const viaTarget = (target: LinuxServer, flag: string) => target.executeCommand(`${ask(flag)} | radclient -x 127.0.0.1:18121 status adminsecret`);

describe('Status-Server statistics', () => {
  it('witness: without FreeRADIUS-Statistics-Type the reply carries no counter', async () => {
    const { target } = await lab();
    const out = await viaTarget(target, '');
    expect(out).toContain('Received Access-Accept');
    expect(out).not.toContain('FreeRADIUS-Total');
  });

  it('Authentication returns the access counters, counted from the two requests made', async () => {
    const { target } = await lab();
    const out = await viaTarget(target, 'Authentication');
    expect(out).toMatch(/FreeRADIUS-Total-Access-Requests = 2\b/);
    expect(out).toMatch(/FreeRADIUS-Total-Access-Accepts = 1\b/);
    expect(out).toMatch(/FreeRADIUS-Total-Access-Rejects = 1\b/);
  });

  it('the attributes come in the order of stats.c authvp', async () => {
    const { target } = await lab();
    const names = [...(await viaTarget(target, 'Authentication')).matchAll(/(FreeRADIUS-Total-[A-Za-z-]+) =/g)].map((match) => match[1]);
    expect(names.slice(0, 5)).toEqual(['FreeRADIUS-Total-Access-Requests', 'FreeRADIUS-Total-Access-Accepts', 'FreeRADIUS-Total-Access-Rejects', 'FreeRADIUS-Total-Access-Challenges', 'FreeRADIUS-Total-Auth-Responses']);
  });

  it('Accounting returns only the accounting counters', async () => {
    const { target } = await lab();
    const out = await viaTarget(target, 'Accounting');
    expect(out).toContain('FreeRADIUS-Total-Accounting-Requests = 0');
    expect(out).not.toContain('FreeRADIUS-Total-Access-Requests');
  });

  it('a numeric mask works as the named value does: 3 is Auth-Acct', async () => {
    const { target } = await lab();
    const out = await viaTarget(target, '3');
    expect(out).toContain('FreeRADIUS-Total-Access-Requests = 2');
    expect(out).toContain('FreeRADIUS-Total-Accounting-Requests = 0');
  });
});
