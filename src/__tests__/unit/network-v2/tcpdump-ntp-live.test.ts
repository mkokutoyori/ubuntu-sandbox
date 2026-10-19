/*
 * The NTP exchange of two simulated machines, seen by tcpdump on one of them.
 * Before the packets travelled as bytes (git stash push -u -- src/network) the capture printed "UDP, length 48" for both directions
 * and -v could not show a single field of the header.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { installVirtualClock } from '../../support/ntpTime';

beforeEach(() => { EquipmentRegistry.resetInstance(); installVirtualClock(); });

async function lab() {
  const srv = new CiscoRouter('SRV');
  const pc = new LinuxPC('linux-pc', 'PC');
  new Cable('c').connect(srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'ntp master 3', 'end']) await srv.executeCommand(c);
  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await pc.executeCommand("printf 'server 10.0.0.1 iburst\\n' | sudo tee /etc/chrony/chrony.conf");
  await pc.executeCommand('sudo tcpdump -i eth0 -nn -v -w /tmp/n.pcap udp port 123 &');
  await pc.executeCommand('sudo systemctl restart chrony');
  await pc.executeCommand('kill %1');
  return { pc, srv };
}

describe('tcpdump on a machine that runs chrony against a Cisco master', () => {
  it('prints the client request and the server reply by name', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('tcpdump -nn -r /tmp/n.pcap');
    expect(out).toMatch(/10\.0\.0\.2\.123 > 10\.0\.0\.1\.123: NTPv4, Client, length 48/);
    expect(out).toMatch(/10\.0\.0\.1\.123 > 10\.0\.0\.2\.123: NTPv4, Server, length 48/);
    expect(out).not.toContain('UDP, length 48');
  });

  it('-v shows the header of the reply: stratum 3 from a master 3 is stratum 3, reference 127.127.1.1', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('tcpdump -nn -v -r /tmp/n.pcap');
    expect(out).toMatch(/Stratum 3 \(secondary reference\), poll 6 \(64s\)/);
    expect(out).toContain('Reference-ID: 0x7f7f0101');
    expect(out).toMatch(/Transmit Timestamp: +\d{10}\.\d{9} \(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ\)/);
  });

  it('the first request of an unsynchronised client declares the alarm condition', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('tcpdump -nn -v -r /tmp/n.pcap');
    expect(out).toContain('Leap indicator: clock unsynchronized (192), Stratum 0 (unspecified)');
  });
});
