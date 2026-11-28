/*
 * Probe: the RFC 2868 tag of a tunnel attribute (Tunnel-Type:1 = VLAN). Source of truth: RFC 2868 section 3.1 (the Tag octet, 0x01-0x1F, groups the attributes of one tunnel; 0x00 means unused) and
 * FreeRADIUS v3.2.x src/lib/valuepair.c (fr_pair_snprint prints `Name:tag` when the tag is valid, 1-31, and nothing for tag 0).
 * The users file parser read the `:1` and dropped it: the codec wrote 0x00 as the tag whatever was asked, so two tunnels in one reply could not be told apart and a reader never saw the tag.
 * It is a criterion read and not enforced (rule 6): the tag now travels in RadiusAttribute.tag, is written by the codec, read back and printed by radclient.
 *
 * Discriminated with git stash on src/network: 4 of 5 fall before the fix. The witness (an untagged tunnel attribute is written with tag 0 and printed without a tag) passes either way.
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
import { encodeRadiusPacket, decodeRadiusPacket, isRadiusDecodeError } from '@/network/radius/codec';
import type { RadiusPacket } from '@/network/radius/types';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

const packet = (attributes: RadiusPacket['attributes']): RadiusPacket => ({ type: 'radius', code: 'access-accept', identifier: 1, authenticator: '00'.repeat(16), attributes });

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

const ask = (client: LinuxServer) => client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -x 10.0.0.2 auth shared`);

describe('RFC 2868 tags', () => {
  it('witness: an untagged Tunnel-Type is written with tag 0 and printed without one', async () => {
    const { client } = await lab('\tTunnel-Type = VLAN\n');
    const out = await ask(client);
    expect(out).toContain('Tunnel-Type = VLAN');
    expect(out).not.toMatch(/Tunnel-Type:\d/);
  });

  it('the codec writes the tag octet of a tagged integer and reads it back', () => {
    const wire = encodeRadiusPacket(packet([{ type: 'tunnel-type', value: 13, tag: 3 }]));
    const decoded = decodeRadiusPacket(wire);
    expect(isRadiusDecodeError(decoded)).toBe(false);
    const attribute = (decoded as RadiusPacket).attributes[0];
    expect(attribute.value).toBe(13);
    expect(attribute.tag).toBe(3);
    expect(Array.from(wire.slice(20, 26))).toEqual([64, 6, 3, 0, 0, 13]);
  });

  it('the codec writes the tag octet of a tagged string', () => {
    const wire = encodeRadiusPacket(packet([{ type: 'tunnel-private-group-id', value: '30', tag: 2 }]));
    const attribute = (decodeRadiusPacket(wire) as RadiusPacket).attributes[0];
    expect(attribute.value).toBe('30');
    expect(attribute.tag).toBe(2);
  });

  it('a users file reply keeps the tag all the way to what radclient prints', async () => {
    const { client } = await lab('\tTunnel-Type:1 = VLAN,\n\tTunnel-Private-Group-Id:1 = "30"\n');
    const out = await ask(client);
    expect(out).toContain('Tunnel-Type:1 = VLAN');
    expect(out).toContain('Tunnel-Private-Group-Id:1 = "30"');
  });

  it('two tunnels in one reply stay distinguishable by their tags', async () => {
    const { client } = await lab('\tTunnel-Type:1 = VLAN,\n\tTunnel-Type:2 = GRE\n');
    const out = await ask(client);
    expect(out).toContain('Tunnel-Type:1 = VLAN');
    expect(out).toContain('Tunnel-Type:2 = GRE');
  });
});
