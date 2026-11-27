/*
 * Probe: vendor-specific attributes by name in the users file. Source of truth: FreeRADIUS v3.2.x share/dictionary.cisco (Cisco-AVPair, vendor 9 type 1,
 * string), dictionary.microsoft (MS-CHAP-Challenge and friends, octets), doc/rfc/dictionary rendering: a reply item written Cisco-AVPair = "shell:priv-lvl=15"
 * is accepted by the users file parser and printed by radclient as Cisco-AVPair = "shell:priv-lvl=15", not as an opaque Vendor-Specific(9:1) in hexadecimal.
 * The simulator's dictionary already knew the vendor sub-attributes (the AAA code and the MS-CHAP path read them) but the users file refused them as unknown
 * attributes and the printers never looked them up. They now share one table (RADIUS_VSA_DICTIONARY, with the display name) for parsing and printing.
 *
 * Discriminated with git stash on src/network: 2 of 4 fall before the fix; the witness (a standard reply attribute is printed as before) and the refusal of a name
 * no dictionary has pass either way: the first is the lab's soundness check, the second a non-regression the fix keeps true.
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

async function lab(users: string) {
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
  write(target, USERS_FILE_PATH, users);
  const started = await target.executeCommand('systemctl restart freeradius');
  return { client, target, started };
}

const ask = (client: LinuxServer) => client.executeCommand(`printf 'User-Name = "netadmin"\\nUser-Password = "pw"\\n' | radclient -x 10.0.0.2 auth shared`);

describe('vendor-specific attributes in the users file', () => {
  it('witness: a standard reply attribute is accepted and printed', async () => {
    const { client, started } = await lab('netadmin Cleartext-Password := "pw"\n  Service-Type = NAS-Prompt-User\n');
    expect(started).not.toContain('Failed');
    expect(await ask(client)).toContain('Service-Type = NAS-Prompt-User');
  });

  it('Cisco-AVPair is accepted in a reply and printed by name with its text value', async () => {
    const { client, started } = await lab('netadmin Cleartext-Password := "pw"\n  Service-Type = NAS-Prompt-User,\n  Cisco-AVPair = "shell:priv-lvl=15"\n');
    expect(started).not.toContain('Failed');
    expect(await ask(client)).toContain('Cisco-AVPair = "shell:priv-lvl=15"');
  });

  it('the Cisco-AVPair reaches the wire in the vendor-specific encoding', async () => {
    const { client } = await lab('netadmin Cleartext-Password := "pw"\n  Cisco-AVPair = "shell:priv-lvl=15"\n');
    const output = await ask(client);
    expect(output).toContain('Received Access-Accept');
    expect(output).not.toContain('Vendor-Specific(9:1)');
  });

  it('an attribute that no dictionary has is still refused, naming it', async () => {
    const { started } = await lab('netadmin Cleartext-Password := "pw"\n  Cisco-No-Such-Thing = "x"\n');
    expect(started).toContain('Unknown attribute "Cisco-No-Such-Thing"');
  });
});
