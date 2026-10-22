/**
 * Probe: label switching in the router data plane over real frames
 * (docs/rfc/mpls/rfc3031.txt §3, rfc3032.txt §2.4, rfc3443.txt §3).
 * Lab: PC1 - R1 - R2 - R3 - PC2 with static LSPs. R2 has NO IP route toward
 * 10.3.0.0/24: only the label binding can carry the traffic, so a ping
 * that succeeds proves the packets were switched, not routed.
 * Before the fix every case fails (the router drops 0x8847 frames and has no
 * imposition); the unlabelled witness (ping inside a /24) passes either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';

async function configure(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function lab(options: { php: boolean }) {
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  new Cable('c1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('c2').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c3').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  new Cable('c4').connect(r3.getPort('GigabitEthernet0/1')!, pc2.getPort('eth0')!);
  await configure(r1, [
    'interface GigabitEthernet0/0', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.3.0.0 255.255.255.0 10.12.0.2',
  ]);
  await configure(r2, [
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.1.0.0 255.255.255.0 10.12.0.1',
  ]);
  await configure(r3, [
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.3.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 10.1.0.0 255.255.255.0 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2',
  ]);
  await pc1.executeCommand('sudo ip addr add 10.1.0.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 10.1.0.1');
  await pc2.executeCommand('sudo ip addr add 10.3.0.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 10.3.0.1');
  const e1 = r1.getMplsEngine();
  const e2 = r2.getMplsEngine();
  const e3 = r3.getMplsEngine();
  e1.enableInterface('GigabitEthernet0/1'); e2.enableInterface('GigabitEthernet0/0');
  e2.enableInterface('GigabitEthernet0/1'); e3.enableInterface('GigabitEthernet0/0');
  e1.lfib.setFtn({ prefix: new IPAddress('10.3.0.0'), prefixLength: 24, outLabels: [MplsLabel.of(100)], iface: 'GigabitEthernet0/1', nextHop: new IPAddress('10.12.0.2') });
  e2.lfib.setIlm(MplsLabel.of(100), options.php
    ? { kind: 'pop', iface: 'GigabitEthernet0/1', nextHop: new IPAddress('10.23.0.3') }
    : { kind: 'swap', outLabels: [MplsLabel.of(200)], iface: 'GigabitEthernet0/1', nextHop: new IPAddress('10.23.0.3') });
  e3.lfib.setIlm(MplsLabel.of(200), { kind: 'pop', iface: null, nextHop: null });
  e3.lfib.setFtn({ prefix: new IPAddress('10.1.0.0'), prefixLength: 24, outLabels: [MplsLabel.of(300)], iface: 'GigabitEthernet0/0', nextHop: new IPAddress('10.23.0.2') });
  e2.lfib.setIlm(MplsLabel.of(300), { kind: 'pop', iface: 'GigabitEthernet0/0', nextHop: new IPAddress('10.12.0.1') });
  return { pc1, pc2, r1, r2, r3, e1, e2, e3 };
}

describe('LSP carries traffic that no IP route could', () => {
  it('WITNESS: without labels R2 has no route to 10.3.0.0/24 and the ping fails', async () => {
    const { pc1, e2 } = await lab({ php: false });
    e2.lfib.removeIlm(MplsLabel.of(100));
    const out = await pc1.executeCommand('ping -c 2 -W 1 10.3.0.10');
    expect(out).toContain('100% packet loss');
    expect(e2.counters.noBinding).toBeGreaterThan(0);
  });

  it('swap at R2, pop at R3: the ping goes through and R2 switched labelled packets', async () => {
    const { pc1, e1, e2, e3 } = await lab({ php: false });
    const out = await pc1.executeCommand('ping -c 2 -W 1 10.3.0.10');
    expect(out).toContain('2 received');
    expect(e1.counters.imposed).toBeGreaterThanOrEqual(2);
    expect(e2.counters.labelledIn).toBeGreaterThanOrEqual(2);
    expect(e3.counters.disposed).toBeGreaterThanOrEqual(2);
  });

  it('penultimate hop popping: R3 receives plain IP and never sees a label', async () => {
    const { pc1, e1, e2, e3 } = await lab({ php: true });
    const out = await pc1.executeCommand('ping -c 2 -W 1 10.3.0.10');
    expect(out).toContain('2 received');
    expect(e2.counters.disposed).toBeGreaterThanOrEqual(2);
    expect(e3.counters.labelledIn).toBe(0);
    expect(e1.counters.imposed).toBeGreaterThanOrEqual(2);
  });

  it('an interface without MPLS drops labelled frames', async () => {
    const { pc1, e2 } = await lab({ php: false });
    e2.disableInterface('GigabitEthernet0/0');
    const out = await pc1.executeCommand('ping -c 1 -W 1 10.3.0.10');
    expect(out).toContain('100% packet loss');
    expect(e2.counters.droppedDisabledInterface).toBeGreaterThan(0);
  });
});

describe('TTL expiry inside the LSP (RFC 3032 §2.3-2.4, RFC 4950)', () => {
  it('R2 answers time-exceeded and the error carries the incoming label stack', async () => {
    const { pc1, r2 } = await lab({ php: false });
    const out = await pc1.executeCommand('traceroute -n -w 1 -m 3 10.3.0.10');
    const lines = out.split('\n');
    expect(lines.find(l => l.startsWith(' 1 '))).toContain('10.1.0.1');
    expect(lines.find(l => l.startsWith(' 2 '))).toContain('10.12.0.2');
    expect(lines.find(l => l.startsWith(' 3 '))).toContain('10.23.0.3');
    expect(r2.getMplsEngine().counters.expired).toBeGreaterThan(0);
  });

  it('the hop reports the incoming label stack of RFC 4950 to the traceroute client', async () => {
    const { pc1 } = await lab({ php: false });
    const hops: Array<{ hop: number; probes: Array<{ extensions?: ReadonlyArray<{ classNum: number; cType: number; stack: ReadonlyArray<{ label: number; ttl: number; bottom: boolean }> }> }> }> = [];
    const probe = pc1 as unknown as { executeTraceroute(...args: unknown[]): Promise<unknown> };
    await probe.executeTraceroute(new IPAddress('10.3.0.10'), 3, 1000, 1, 1, { onHop: (hop: never) => { hops.push(hop); } }, { kind: 'default-udp', port: 33434 }, {});
    const second = hops.find(h => h.hop === 2)!;
    const object = second.probes[0].extensions![0];
    expect([object.classNum, object.cType]).toEqual([1, 1]);
    expect(object.stack.map(e => [e.label, e.ttl, e.bottom])).toEqual([[100, 1, true]]);
    expect(hops.find(h => h.hop === 1)!.probes[0].extensions).toBeUndefined();
  });

  it('tunnels the error to the LSP end when the core has no route to the source (§2.3.1)', async () => {
    const { pc1, r2 } = await lab({ php: false });
    await configure(r2, ['no ip route 10.1.0.0 255.255.255.0 10.12.0.1']);
    const out = await pc1.executeCommand('traceroute -n -w 1 -m 3 10.3.0.10');
    expect(out.split('\n').find(l => l.startsWith(' 2 '))).toContain('10.12.0.2');
  });
});
