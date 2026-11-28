/*
 * Probe: the statistics a status listener serves. Source of truth: FreeRADIUS v3.2.x src/main/stats.c (request_stats_reply: statistics only on a status
 * listener, FreeRADIUS-Statistics-Type is a bit mask, 0x01 authentication and 0x02 accounting, masked out when 0xe0 asks for a client, server or home server;
 * request_stats_addvp walks authvp / acctvp in order) and share/dictionary.freeradius (vendor 11344, attribute numbers 127 and 128-137, 148-154, 191, 192, the value
 * names of FreeRADIUS-Statistics-Type). The simulator's dictionary had no FreeRADIUS attribute, so a Status-Server answered only a Message-Authenticator.
 * The counters are the ones radmin already reads (`stats auth`): one store, two views. Not served: the elapsed histogram (vendor attribute 198 is a TLV in 3.x), the
 * Flag 0x80 with a home server address and port returns outstanding requests, the state (Idle until the server has answered or been probed) and the proxy counters of the kinds asked, or
 * "Failed to find home server IP" / "No home server port supplied" / "Home server is not acct"; the times of life and death, the EMA window and the last packet times are not served. Flag 0x40 with FreeRADIUS-Stats-Server-IP-Address and -Port returns the counters of that listener (the ones `radmin stats socket` reads) after echoing both,
 * or "No such listener" / "No listener IP address supplied" in FreeRADIUS-Stats-Error. Flag 0x20 with FreeRADIUS-Stats-Client-IP-Address returns that client's own counters (client_authvp / client_acctvp: no conflicts counter) after an echo of the
 * address, or FreeRADIUS-Stats-Error "No such client"; FreeRADIUS-Stats-Client-Number selects the nth client of the table (client_findbynumber) and echoes its address and, below /32, its
 * netmask. IPv6 clients are not served. Flag 0x10 (internal) returns the start and HUP times, the five queue lengths and PPS (zero: no queue is modelled) and the thread counts radmin `stats threads` prints. Flags 4 and 8 return the proxy counters (the home servers' global store), masked out by 0x20 as stats.c does.
 *
 * Discriminated with git stash on src/network against the tree before any statistics: 16 of 19 fall (4 for the Authentication/Accounting counters, 1 for the proxy mask, 1 for the internal mask, 2 for the client mask, 2 for the client number, 4 for the home-server mask, the last seven measured separately
 * against the version without them). Two pass either way and are named: the witness (a Status-Server without the attribute is answered with no counter) and the 0x20 mask case, a
 * non-regression that is vacuously true until a counter is served.
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

const PROXY = '/etc/freeradius/3.0/proxy.conf';

async function lab(proxy = '') {
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
  if (proxy !== '') write(target, PROXY, proxy);
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

  it('Proxy-Authentication returns the proxy auth counters, none of the local ones', async () => {
    const { target } = await lab();
    const out = await viaTarget(target, 'Proxy-Authentication');
    expect(out).toContain('FreeRADIUS-Total-Proxy-Access-Requests = 0');
    expect(out).not.toContain('FreeRADIUS-Total-Access-Requests');
  });

  it('a client bit (0x20) takes the proxy counters out, as stats.c masks them', async () => {
    const { target } = await lab();
    expect(await viaTarget(target, '36')).not.toContain('FreeRADIUS-Total-Proxy');
  });

  it('Internal returns the start and HUP times, the queue lengths and the thread counts of the daemon', async () => {
    const { target } = await lab();
    const out = await viaTarget(target, 'Internal');
    const value = (name: string) => Number(new RegExp(`${name} = (\\d+)`).exec(out)?.[1] ?? NaN);
    expect(out).toMatch(/FreeRADIUS-Stats-Start-Time = "[A-Z][a-z]{2} \d{2} \d{4} /);
    expect(out).toMatch(/FreeRADIUS-Stats-HUP-Time = "/);
    expect(value('FreeRADIUS-Queue-Len-Internal')).toBe(0);
    expect(value('FreeRADIUS-Stats-Threads-Max')).toBeGreaterThan(0);
    expect(value('FreeRADIUS-Stats-Threads-Total')).toBeLessThanOrEqual(value('FreeRADIUS-Stats-Threads-Max'));
    expect(out).not.toContain('FreeRADIUS-Total-Access-Requests');
  });

  const withClient = (target: LinuxServer, flag: string, address: string) =>
    target.executeCommand(`printf 'Message-Authenticator = 0x00\\nFreeRADIUS-Statistics-Type = ${flag}\\nFreeRADIUS-Stats-Client-IP-Address = ${address}\\n' | radclient -x 127.0.0.1:18121 status adminsecret`);

  it('a client mask with a known client address returns that client counters after echoing the address', async () => {
    const { target } = await lab();
    const out = await withClient(target, '33', '10.0.0.1');
    expect(out).toMatch(/FreeRADIUS-Stats-Client-IP-Address = 10\.0\.0\.1/);
    expect(out).toMatch(/FreeRADIUS-Total-Access-Requests = 2\b/);
    expect(out).not.toContain('FreeRADIUS-Total-Auth-Conflicts');
    expect(out).not.toContain('FreeRADIUS-Stats-Error');
  });

  it('an address that is no client gets FreeRADIUS-Stats-Error and no counter', async () => {
    const { target } = await lab();
    const out = await withClient(target, '33', '192.0.2.99');
    expect(out).toContain('FreeRADIUS-Stats-Error = "No such client"');
    expect(out).not.toContain('FreeRADIUS-Total');
  });

  const withServer = (target: LinuxServer, flag: string, extra: string) =>
    target.executeCommand(`printf 'Message-Authenticator = 0x00\\nFreeRADIUS-Statistics-Type = ${flag}\\n${extra}' | radclient -x 127.0.0.1:18121 status adminsecret`);

  it('a server mask names a listener and returns its own counters after echoing its address and port', async () => {
    const { target } = await lab();
    const out = await withServer(target, '65', 'FreeRADIUS-Stats-Server-IP-Address = 127.0.0.1\\nFreeRADIUS-Stats-Server-Port = 1812\\n');
    expect(out).toContain('FreeRADIUS-Stats-Server-Port = 1812');
    expect(out).toMatch(/FreeRADIUS-Total-Access-Requests = 2\b/);
  });

  it('a port that no listener serves gets "No such listener"', async () => {
    const { target } = await lab();
    const out = await withServer(target, '65', 'FreeRADIUS-Stats-Server-IP-Address = 127.0.0.1\\nFreeRADIUS-Stats-Server-Port = 1999\\n');
    expect(out).toContain('FreeRADIUS-Stats-Error = "No such listener"');
    expect(out).not.toContain('FreeRADIUS-Total');
  });

  it('a server mask without an address says so', async () => {
    const { target } = await lab();
    const out = await withServer(target, '65', 'FreeRADIUS-Stats-Server-Port = 1812\\n');
    expect(out).toContain('FreeRADIUS-Stats-Error = "No listener IP address supplied"');
  });

  const HOME = 'home_server home1 {\n  ipaddr = 10.0.0.3\n  port = 1812\n  type = auth\n  secret = homesecret\n}\n';
  const withHome = (target: LinuxServer, flag: string, extra: string) =>
    target.executeCommand(`printf 'Message-Authenticator = 0x00\\nFreeRADIUS-Statistics-Type = ${flag}\\n${extra}' | radclient -x 127.0.0.1:18121 status adminsecret`);
  const HOME_ID = 'FreeRADIUS-Stats-Server-IP-Address = 10.0.0.3\\nFreeRADIUS-Stats-Server-Port = 1812\\n';

  it('a home server mask returns outstanding requests, its state and the proxy counters', async () => {
    const { target } = await lab(HOME);
    const out = await withHome(target, '129', HOME_ID);
    expect(out).toContain('FreeRADIUS-Stats-Server-Outstanding-Requests = 0');
    expect(out).toContain('FreeRADIUS-Stats-Server-State = Idle');
    expect(out).toContain('FreeRADIUS-Total-Proxy-Access-Requests = 0');
    expect(out).not.toContain('FreeRADIUS-Stats-Error');
  });

  it('an address that is no home server gets "Failed to find home server IP"', async () => {
    const { target } = await lab(HOME);
    expect(await withHome(target, '129', 'FreeRADIUS-Stats-Server-IP-Address = 10.9.9.9\\nFreeRADIUS-Stats-Server-Port = 1812\\n')).toContain('FreeRADIUS-Stats-Error = "Failed to find home server IP"');
  });

  it('asking accounting counters of an auth home server says it is not acct', async () => {
    const { target } = await lab(HOME);
    expect(await withHome(target, '130', HOME_ID)).toContain('FreeRADIUS-Stats-Error = "Home server is not acct"');
  });

  it('a home server mask without a port says so', async () => {
    const { target } = await lab(HOME);
    expect(await withHome(target, '129', 'FreeRADIUS-Stats-Server-IP-Address = 10.0.0.3\\n')).toContain('FreeRADIUS-Stats-Error = "No home server port supplied"');
  });

  const byNumber = (target: LinuxServer, number: number) =>
    target.executeCommand(`printf 'Message-Authenticator = 0x00\\nFreeRADIUS-Statistics-Type = 33\\nFreeRADIUS-Stats-Client-Number = ${number}\\n' | radclient -x 127.0.0.1:18121 status adminsecret`);

  it('a client number selects the client, echoes its address and returns its counters', async () => {
    const { target } = await lab();
    const out = await byNumber(target, 0);
    expect(out).toContain('FreeRADIUS-Stats-Client-Number = 0');
    expect(out).toMatch(/FreeRADIUS-Stats-Client-IP-Address = 10\.0\.0\.1/);
    expect(out).toMatch(/FreeRADIUS-Total-Access-Requests = 2\b/);
  });

  it('a number past the last client gets "No such client"', async () => {
    const { target } = await lab();
    expect(await byNumber(target, 99)).toContain('FreeRADIUS-Stats-Error = "No such client"');
  });
});
