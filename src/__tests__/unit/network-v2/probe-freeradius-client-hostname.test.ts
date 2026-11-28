/*
 * Probe: a client named by host name in clients.conf. Source of truth: FreeRADIUS v3.2.x src/main/client.c (client_parse: ipaddr / ipv4addr / ipv6addr go through ip_hostaddr, which resolves a
 * name with the system resolver at load; the name of a `client <name> {}` section is taken as the address when no ipaddr is given) and raddb/clients.conf ("ipaddr = hostname").
 * The simulator's grammar took only addresses and refused a name. The name now goes to the machine's own resolver (rule 1b: LinuxServer hands RadiusdService
 * executor.resolvedHost), so /etc/hosts answers it as it answers every other command. Not served: a name only a DNS server knows, which needs the configuration loader to be asynchronous (TODO.md).
 *
 * Discriminated with git stash on src: 2 of 5 fall before the fix. Three pass either way and are named: the witness (a literal address), the changed-hosts case (an unknown client either way, vacuously true before) and the unresolvable name (still refused).
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

async function lab(clients: string, hosts = '10.0.0.1 nas.lab\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  if (hosts !== '') write(target, '/etc/hosts', `127.0.0.1 localhost\n${hosts}`);
  write(target, CLIENTS_CONF_PATH, clients);
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  const started = await target.executeCommand('systemctl restart freeradius');
  return { client, target, started };
}

const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n'`;
const accepted = async (made: Awaited<ReturnType<typeof lab>>) => (await made.client.executeCommand(`${ALICE} | radclient -t 1 -r 1 10.0.0.2 auth shared`)).includes('Received Access-Accept');
const checkError = (made: Awaited<ReturnType<typeof lab>>) => (made.target.getRadiusd().checkConfig() as { error?: string }).error ?? '';

describe('a client named by host name', () => {
  it('witness: a literal address is still a client', async () => {
    expect(await accepted(await lab('client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n'))).toBe(true);
  });

  it('ipaddr = a name that /etc/hosts resolves makes that machine a client', async () => {
    expect(await accepted(await lab('client lab {\n  ipaddr = nas.lab\n  secret = shared\n}\n'))).toBe(true);
  });

  it('a client section named by the host name, with no ipaddr, is resolved too', async () => {
    expect(await accepted(await lab('client nas.lab {\n  secret = shared\n}\n'))).toBe(true);
  });

  it('the name is resolved by the machine: another address in /etc/hosts makes the same request unknown', async () => {
    expect(await accepted(await lab('client lab {\n  ipaddr = nas.lab\n  secret = shared\n}\n', '10.0.0.77 nas.lab\n'))).toBe(false);
  });

  it('a name nothing resolves is still refused, naming it', async () => {
    const made = await lab('client lab {\n  ipaddr = ghost.lab\n  secret = shared\n}\n');
    expect(checkError(made)).toContain('Failed parsing client address "ghost.lab"');
  });
});
