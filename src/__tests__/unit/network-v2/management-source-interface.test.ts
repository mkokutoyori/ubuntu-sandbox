/**
 * `source-interface` chooses an ADDRESS, not a way out.
 *
 * The egress interface and the source address are two different
 * decisions: routing picks the first, the operator picks the second.
 * Three agents got this wrong in three different ways, and the family
 * only became visible once traps and NetFlow really exported.
 *
 *   - Syslog returned the source interface AS the egress port. Pointed
 *     at a loopback — the whole point of the command — the datagram was
 *     sent out of a port with no cable, so NOTHING left the machine.
 *     `logging source-interface Loopback0` silenced the very feature it
 *     configures. Measured: 21 datagrams without it, zero with it.
 *   - NetFlow had the identical line, hence the identical defect. My
 *     first reading called NetFlow the witness that "honours" the
 *     setting; that was wrong, and is recorded here rather than dropped.
 *   - SNMP never consulted `snmp-server trap-source` at all: stored,
 *     rendered in the running-config, read by nobody. Every trap left
 *     with the egress interface's address, so a collector filtering on
 *     the loopback saw none of them.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, IPv4Packet, UDPPacket } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';

const cfg = async (r: CiscoRouter, lines: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
};

/** Source addresses of the datagrams actually sent to `port`. */
function sourcesSentTo(source: Equipment, port: number): string[] {
  const seen: string[] = [];
  source.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const ip = frame.payload as IPv4Packet | undefined;
    if (ip?.type !== 'ipv4') return;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.destinationPort === port) seen.push(ip.sourceIP.toString());
  });
  return seen;
}

/**
 * A router with a loopback, a collector on Gi0/0, and Gi0/1 to shake.
 *
 * The shaken link is not the collector's: cutting the only route to the
 * collector would stop the export arriving and prove nothing here.
 */
async function lab(source: boolean): Promise<{ r: CiscoRouter; outputs: string[] }> {
  const r = new CiscoRouter('R1');
  const collector = new LinuxPC('COLLECTOR');
  collector.powerOn();
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, collector.getPort('eth0')!);
  collector.configureInterface('eth0', new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

  const outputs = await cfg(r, [
    'enable', 'configure terminal',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'logging host 10.0.0.50', 'logging trap debugging',
    ...(source ? ['logging source-interface Loopback0'] : []),
    'snmp-server community public RO',
    'snmp-server host 10.0.0.50 version 2c public',
    ...(source ? ['snmp-server trap-source Loopback0'] : []),
    'snmp-server enable traps snmp linkdown linkup',
    'end',
  ]);
  return { r, outputs };
}

const shakeLink = (r: CiscoRouter): Promise<string[]> =>
  cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);

describe('syslog', () => {
  it('still leaves when a source interface is configured', async () => {
    // The core of the defect: it used to leave by the loopback, so it
    // never left at all.
    const { r } = await lab(true);
    const syslog = sourcesSentTo(r, 514);
    await shakeLink(r);
    expect(syslog.length).toBeGreaterThan(0);
  });

  it('and carries the configured address', async () => {
    const { r } = await lab(true);
    const syslog = sourcesSentTo(r, 514);
    await shakeLink(r);
    expect([...new Set(syslog)]).toEqual(['1.1.1.1']);
  });

  it('without the command it carries the egress address', async () => {
    const { r } = await lab(false);
    const syslog = sourcesSentTo(r, 514);
    await shakeLink(r);
    expect([...new Set(syslog)]).toEqual(['10.0.0.1']);
  });
});

describe('snmp traps', () => {
  it('carry the trap-source address', async () => {
    const { r } = await lab(true);
    const traps = sourcesSentTo(r, 162);
    await shakeLink(r);
    expect([...new Set(traps)]).toEqual(['1.1.1.1']);
  });

  it('without the command they carry the egress address', async () => {
    const { r } = await lab(false);
    const traps = sourcesSentTo(r, 162);
    await shakeLink(r);
    expect([...new Set(traps)]).toEqual(['10.0.0.1']);
  });
});

describe('what the source interface does not change', () => {
  it('the datagram still reaches the collector, so the way out is unchanged', async () => {
    // A source address that also rerouted the packet would be the very
    // bug this fixes, in the other direction.
    const { r } = await lab(true);
    const syslog = sourcesSentTo(r, 514);
    const traps = sourcesSentTo(r, 162);
    await shakeLink(r);
    expect(syslog.length).toBeGreaterThan(0);
    expect(traps.length).toBeGreaterThan(0);
  });

  it('an unknown source interface falls back to the egress address', async () => {
    const r = new CiscoRouter('R1');
    const collector = new LinuxPC('COLLECTOR');
    collector.powerOn();
    new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, collector.getPort('eth0')!);
    collector.configureInterface('eth0', new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));
    await cfg(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'logging host 10.0.0.50', 'logging trap debugging',
      'logging source-interface Loopback9', 'end',
    ]);
    const syslog = sourcesSentTo(r, 514);
    await shakeLink(r);
    // Silence here would be the original defect all over again.
    expect([...new Set(syslog)]).toEqual(['10.0.0.1']);
  });
});
