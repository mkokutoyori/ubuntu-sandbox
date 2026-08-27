/**
 * `snmp-server enable traps` arms something.
 *
 * Two defects, measured together because they come from the same store.
 *
 * THE COMMAND EMITTED NOTHING. `SnmpAgent.sendTrap` is real and
 * correct, and its only callers were IP SLA and EEM: no STANDARD
 * notification ever left the machine, linkDown and linkUp included —
 * the most classic of all. `enabledTraps` was stored, rendered in the
 * configuration, and read by nobody.
 *
 * THE RENDERED CONFIGURATION DID NOT REPRODUCE WHAT WAS TYPED. The
 * parser added EVERY suffix of the line, so `enable traps snmp linkdown
 * linkup` came back as THREE lines — two of which nobody wrote. That
 * matters beyond display: the rendered configuration is REPLAYED when a
 * topology is imported, so it multiplied on every round trip.
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

/**
 * A router, a collector on Gi0/0, and a link to shake on Gi0/1.
 *
 * The shaken link is NOT the collector's: cutting the only route to the
 * collector would stop the notification arriving, which is true on a
 * real machine and would prove nothing here.
 */
async function lab(traps: string[] = ['snmp linkdown linkup']): Promise<{
  r: CiscoRouter; pair: LinuxPC; outputs: string[];
}> {
  const r = new CiscoRouter('R1');
  const collector = new LinuxPC('COLLECTEUR');
  const pair = new LinuxPC('PAIR');
  collector.powerOn(); pair.powerOn();
  new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, collector.getPort('eth0')!);
  new Cable('b').connect(r.getPort('GigabitEthernet0/1')!, pair.getPort('eth0')!);
  collector.configureInterface('eth0', new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

  const outputs = await cfg(r, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'snmp-server community public RO',
    'snmp-server host 10.0.0.50 version 2c public',
    ...traps.map((t) => `snmp-server enable traps ${t}`.trim()),
    'end',
  ]);
  return { r, pair, outputs };
}

/** Les OID de notification reellement emis. */
function observeTraps(source: Equipment): string[] {
  const seen: string[] = [];
  source.getBus().subscribe('snmp.trap.sent', (e) => {
    seen.push((e.payload as { trapOid: string }).trapOid);
  });
  return seen;
}

/** Les datagrammes UDP reellement partis vers le port des notifications. */
function observeUdp162(source: Equipment): number[] {
  const seen: number[] = [];
  source.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const ip = frame.payload as IPv4Packet | undefined;
    if (ip?.type !== 'ipv4') return;
    const udp = ip.payload as UDPPacket | undefined;
    if (udp?.type === 'udp' && udp.destinationPort === 162) seen.push(udp.destinationPort);
  });
  return seen;
}

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const LINK_UP = '1.3.6.1.6.3.1.1.5.4';

describe('une interface qui tombe le fait savoir', () => {
  it('shutdown emet linkDown, no shutdown emet linkUp', async () => {
    const { r } = await lab();
    const traps = observeTraps(r);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN]);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN, LINK_UP]);
  });

  it('et la notification part vraiment sur le wire, en UDP/162', async () => {
    const { r } = await lab();
    const udp = observeUdp162(r);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    expect(udp.length).toBeGreaterThan(0);
  });
});

describe('ce qui n\'est pas arme ne part pas', () => {
  it('sans `enable traps`, rien n\'est emis', async () => {
    const { r } = await lab([]);
    const traps = observeTraps(r);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    expect(traps).toEqual([]);
  });

  it('`enable traps snmp linkdown` seul n\'arme pas linkUp', async () => {
    const { r } = await lab(['snmp linkdown']);
    const traps = observeTraps(r);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN]);
  });

  it('`enable traps` all court arme les deux', async () => {
    const { r } = await lab(['']);
    const traps = observeTraps(r);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'shutdown', 'end']);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/1', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN, LINK_UP]);
  });
});

describe('un etat qui ne change pas ne se notifie pas', () => {
  it('une interface SANS cable n\'emet qu\'un seul linkDown', async () => {
    // Measured: `shutdown` then `no shutdown` on an uncabled interface
    // both leave the link down. A real router notifies once.
    const { r } = await lab();
    const traps = observeTraps(r);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/2', 'shutdown', 'end']);
    await cfg(r, ['configure terminal', 'interface GigabitEthernet0/2', 'no shutdown', 'end']);
    expect(traps).toEqual([LINK_DOWN]);
  });
});

describe('la configuration reproduit ce qu\'on a tape', () => {
  it('une commande donne une line, pas trois', async () => {
    const { r } = await lab(['snmp linkdown linkup']);
    const rc = await r.executeCommand('show running-config');
    expect(rc.split('\n').filter((l) => l.includes('enable traps')))
      .toEqual(['snmp-server enable traps snmp linkdown linkup']);
  });

  it('deux commandes sur le meme type se fondent en une, comme sur IOS', async () => {
    const { r } = await lab(['snmp linkdown', 'snmp linkup']);
    const rc = await r.executeCommand('show running-config');
    expect(rc.split('\n').filter((l) => l.includes('enable traps')))
      .toEqual(['snmp-server enable traps snmp linkdown linkup']);
  });

  it('deux types differents restent deux lines', async () => {
    const { r } = await lab(['snmp linkdown', 'config']);
    const lines = (await r.executeCommand('show running-config'))
      .split('\n').filter((l) => l.includes('enable traps'));
    expect(lines).toEqual([
      'snmp-server enable traps snmp linkdown',
      'snmp-server enable traps config',
    ]);
  });
});
