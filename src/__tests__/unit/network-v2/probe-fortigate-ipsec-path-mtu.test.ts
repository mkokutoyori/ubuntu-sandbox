/*
 * Probe: a FortiGate IPsec tunnel carrying a large TCP transfer. Two measurements on the e-commerce lab, before the fix:
 *   - ping -M do -s 1472 across the tunnel: "100% packet loss", no ICMP, where Linux prints "Frag needed and DF set (mtu = ...)";
 *   - curl of a 200 KB file through the tunnel: timeout (000), while the same file within one site downloads; the Active Directory replication of a second
 *     domain controller (one large TCP response) failed across the tunnel for the same reason ("no reply from replication partner").
 * RFC 4301 section 8.1 and RFC 1191: a gateway that cannot send a DF packet because the tunnel adds its overhead drops it and answers the sender with ICMP
 * destination unreachable / fragmentation needed carrying the usable MTU, so the sender's path MTU discovery shrinks its segments. The shared IPsec engine
 * already computed that ICMP (lastEncapICMP) and the router used it; the FortiGate forwarding path ignored it, and treated the empty result as a failed
 * negotiation (the tunnel was marked down). The FortiGate now sends the ICMP back through the route to the sender and leaves the tunnel up.
 *
 * Discriminated with git stash on src/network: 3 of 5 fall before the fix; the witness (a small DF ping) and the DF-clear fragmentation case pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PSK = 'probe-psk';
const config = (name: string, wan: string, lan: string, remote: string, peerLan: string): string[] => [
  'config system global', `set hostname ${name}`, 'end',
  'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next',
  'edit port1', 'set mode static', `set ip ${lan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
  'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2', `set remote-gw ${remote}`, `set psksecret ${PSK}`,
  'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end',
  'config vpn ipsec phase2-interface', 'edit "t"', 'set phase1name "t"', 'set proposal aes256-sha256', 'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
  'config router static', 'edit 1', `set dst ${peerLan} 255.255.255.0`, 'set device "t"', 'next', 'end',
  'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "t"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
  'edit 2', 'set srcintf "t"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
];

async function lab() {
  const bus = new EventBus();
  const a = new LinuxServer('linux-server', 'A');
  const b = new LinuxServer('linux-server', 'B');
  const fa = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
  const fb = new FortiGate('firewall-fortinet', 'FGT-B', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [a, b, fa, fb, sw]) device.setEventBus(bus);
  new Cable('1').connect(a.getPort('eth0')!, fa.getPort('port1')!);
  new Cable('2').connect(fa.getPort('wan1')!, sw.getPort('FastEthernet0/1')!);
  new Cable('3').connect(fb.getPort('wan1')!, sw.getPort('FastEthernet0/2')!);
  new Cable('4').connect(fb.getPort('port1')!, b.getPort('eth0')!);
  a.configureInterface('eth0', new IPAddress('10.1.0.50'), new SubnetMask('255.255.255.0'));
  b.configureInterface('eth0', new IPAddress('10.2.0.50'), new SubnetMask('255.255.255.0'));
  await a.executeCommand('ip route add default via 10.1.0.1');
  await b.executeCommand('ip route add default via 10.2.0.1');
  for (const line of config('FGT-A', '203.0.113.1', '10.1.0.1', '203.0.113.2', '10.2.0.0')) await fa.executeCommand(line);
  for (const line of config('FGT-B', '203.0.113.2', '10.2.0.1', '203.0.113.1', '10.1.0.0')) await fb.executeCommand(line);
  await b.executeCommand('apt install -y nginx');
  await b.executeCommand("head -c 200000 /dev/zero | tr '\\0' 'a' > /var/www/html/big.bin");
  await b.executeCommand('systemctl restart nginx');
  await a.executeCommand('ping -c 1 10.2.0.50');
  return { a, b, fa };
}

describe('a large flow through a FortiGate IPsec tunnel', () => {
  it('witness: a small DF packet crosses the tunnel', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('ping -c 1 -M do -s 1000 10.2.0.50')).toContain('1 received');
  });

  it('a DF packet the tunnel overhead makes too big is answered with Frag needed and the usable MTU', async () => {
    const { a } = await lab();
    const output = await a.executeCommand('ping -c 1 -M do -s 1472 10.2.0.50');
    expect(output).toMatch(/From 10\.1\.0\.1 icmp_seq=1 Frag needed and DF set \(mtu = 14\d\d\)/);
  });

  it('a 200 KB download through the tunnel completes by path MTU discovery', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('curl -s -m 20 -o /dev/null -w "%{http_code} %{size_download}" http://10.2.0.50/big.bin')).toBe('200 200000');
  });

  it('the oversize drop does not take the tunnel down', async () => {
    const { a, fa } = await lab();
    await a.executeCommand('ping -c 1 -M do -s 1472 10.2.0.50');
    expect(await fa.executeCommand('get vpn ipsec tunnel summary')).toMatch(/'t'.*selectors\(total,up\): 1\/1/);
  });

  it('a packet without DF is fragmented and arrives', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('ping -c 1 -M dont -s 1472 10.2.0.50')).toContain('1 received');
  });
});
