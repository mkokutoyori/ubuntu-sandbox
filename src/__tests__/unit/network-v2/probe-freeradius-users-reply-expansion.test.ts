/*
 * Probe: the reply items of the users file are expanded. Source of truth: FreeRADIUS v3.2.x raddb/mods-config/files/authorize (the shipped examples write `Reply-Message = "Hello, %{User-Name}"`),
 * src/modules/rlm_files and src/main/valuepair.c radius_pairmove / pairlist xlat: a double-quoted value of a reply item is expanded with the request when the reply is built.
 * The simulator copied the text, so a client received `Hello, %{User-Name}` literally. The expansion is the one the unlang `update` and `detail` use (%{Attr}, %{list:Attr}, %{%{A}:-B}, %{toupper:...}).
 *
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix. The witness (a value without %{ is sent as written) passes either way.
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


async function lab(reply: string) {
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
  write(target, USERS_FILE_PATH, `alice Cleartext-Password := "wonderland"\n${reply}`);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

const ask = (client: LinuxServer) => client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\nCalling-Station-Id = "aa-bb"\\n' | radclient -x 10.0.0.2 auth shared`);

describe('users file reply expansion', () => {
  it('witness: a reply value without an expansion is sent as written', async () => {
    const { client } = await lab('\tReply-Message = "plain text"\n');
    expect(await ask(client)).toContain('Reply-Message = "plain text"');
  });

  it('%{User-Name} is replaced by the name of the request', async () => {
    const { client } = await lab('\tReply-Message = "Hello, %{User-Name}"\n');
    expect(await ask(client)).toContain('Reply-Message = "Hello, alice"');
  });

  it('any attribute of the request can be quoted, and a default covers an absent one', async () => {
    const { client } = await lab('\tReply-Message = "from %{Calling-Station-Id} via %{%{NAS-Identifier}:-nowhere}"\n');
    expect(await ask(client)).toContain('Reply-Message = "from aa-bb via nowhere"');
  });

  it('a function of the expander applies: %{toupper:%{User-Name}}', async () => {
    const { client } = await lab('\tReply-Message = "%{toupper:%{User-Name}}"\n');
    expect(await ask(client)).toContain('Reply-Message = "ALICE"');
  });
});
