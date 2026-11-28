/*
 * Probe: attributes of the RFC dictionaries the simulator did not know. Source of truth: FreeRADIUS v3.2.x share/dictionary.rfc2865 (Framed-IPX-Network 23, Login-LAT-* 34-36 and 63, Framed-AppleTalk-* 37-39),
 * rfc2866 (Acct-Multi-Session-Id 50, Acct-Link-Count 51), rfc2867 (Acct-Tunnel-Connection 68, Acct-Tunnel-Packets-Lost 86), rfc2868 (Tunnel-Client-Endpoint 66, Tunnel-Server-Endpoint 67,
 * Tunnel-Assignment-Id 82, Tunnel-Preference 83, Tunnel-Client-Auth-Id 90, Tunnel-Server-Auth-Id 91, tagged), rfc2869 (ARAP-* 70-74 and 84, Password-Retry 75, Prompt 76, Connect-Info 77,
 * Configuration-Token 78, Acct-Interim-Interval 85), rfc4372 (Chargeable-User-Identity 89), rfc4818 (Delegated-IPv6-Prefix 123). The users file and radclient refused them with `Unknown attribute`
 * where the real server knows them. Tunnel-Password (69) is not added: its salted encryption is not modelled.
 *
 * Discriminated with git stash on src/network: 5 of 7 fall before the fix. Two pass either way and are named: the witness (a known attribute is still accepted) and the unknown name, whose
 * assertion (the name is not echoed) is vacuously true before and still true after; it guards that the dictionary did not become permissive.
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
import { encodeRadiusPacket, decodeRadiusPacket } from '@/network/radius/codec';
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

describe('attributes of the RFC dictionaries', () => {
  it('witness: a known attribute is still accepted', async () => {
    const { client } = await lab('\tFramed-IP-Address = 10.9.9.9\n');
    expect(await ask(client)).toContain('Framed-IP-Address = 10.9.9.9');
  });

  it('the users file accepts Acct-Interim-Interval, Framed-IPX-Network, Connect-Info and the AppleTalk attributes, and radclient prints them under the dictionary names', async () => {
    const { client } = await lab('\tAcct-Interim-Interval = 300,\n\tFramed-IPX-Network = 10.1.1.1,\n\tConnect-Info = "CONNECT 100Mbps",\n\tFramed-AppleTalk-Zone = "lab",\n\tFramed-AppleTalk-Link = 7\n');
    const out = await ask(client);
    expect(out).toContain('Acct-Interim-Interval = 300');
    expect(out).toContain('Framed-IPX-Network = 10.1.1.1');
    expect(out).toContain('Connect-Info = "CONNECT 100Mbps"');
    expect(out).toContain('Framed-AppleTalk-Zone = "lab"');
    expect(out).toContain('Framed-AppleTalk-Link = 7');
  });

  it('the tagged RFC 2868 attributes keep their tag', async () => {
    const { client } = await lab('\tTunnel-Preference:1 = 5,\n\tTunnel-Client-Endpoint:1 = "192.0.2.1",\n\tTunnel-Assignment-Id:1 = "grp"\n');
    const out = await ask(client);
    expect(out).toContain('Tunnel-Preference:1 = 5');
    expect(out).toContain('Tunnel-Client-Endpoint:1 = "192.0.2.1"');
    expect(out).toContain('Tunnel-Assignment-Id:1 = "grp"');
  });

  it('Chargeable-User-Identity and Delegated-IPv6-Prefix survive the codec', () => {
    const wire = encodeRadiusPacket({ type: 'radius', code: 'access-accept', identifier: 1, authenticator: '00'.repeat(16), attributes: [
      { type: 'chargeable-user-identity', value: 'abcd01' }, { type: 'delegated-ipv6-prefix', value: '2001:db8::/48' },
    ] } as RadiusPacket);
    const decoded = decodeRadiusPacket(wire) as RadiusPacket;
    expect(decoded.attributes.map((attribute) => `${attribute.type}=${attribute.value}`)).toEqual(['chargeable-user-identity=abcd01', 'delegated-ipv6-prefix=2001:db8::/48']);
  });

  it('the second pass: Operator-Name, Framed-IPv6-Address, DNS-Server-IPv6-Address, Egress-VLANID and Digest-CNonce print under the dictionary spelling', async () => {
    const { client } = await lab('\tOperator-Name = "1example.org",\n\tFramed-IPv6-Address = 2001:db8::5,\n\tDNS-Server-IPv6-Address = 2001:db8::53,\n\tEgress-VLANID = 30,\n\tDigest-CNonce = "abc"\n');
    const out = await ask(client);
    expect(out).toContain('Operator-Name = "1example.org"');
    expect(out).toContain('Framed-IPv6-Address = 2001:db8::5');
    expect(out).toContain('DNS-Server-IPv6-Address = 2001:db8::53');
    expect(out).toContain('Egress-VLANID = 30');
    expect(out).toContain('Digest-CNonce = "abc"');
  });

  it('the third pass: Management-Privilege-Level, Service-Selection and PMIP6-Home-LMA-IPv6-Address print under the dictionary spelling', async () => {
    const { client } = await lab('\tManagement-Privilege-Level = 15,\n\tService-Selection = "internet",\n\tPMIP6-Home-LMA-IPv6-Address = 2001:db8::1\n');
    const out = await ask(client);
    expect(out).toContain('Management-Privilege-Level = 15');
    expect(out).toContain('Service-Selection = "internet"');
    expect(out).toContain('PMIP6-Home-LMA-IPv6-Address = 2001:db8::1');
  });

  it('a name the real dictionary does not have is still refused', async () => {
    const { client } = await lab('\tNo-Such-Attribute = 1\n');
    expect(await ask(client)).not.toContain('No-Such-Attribute');
  });
});
