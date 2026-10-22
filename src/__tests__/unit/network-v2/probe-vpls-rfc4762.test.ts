/**
 * Probe: VPLS over LDP (docs/rfc/mpls/rfc4762.txt §4, §6.1.1, §6.2, §7, §9;
 * docs/rfc/mpls/rfc4447.txt §5.3 for the Generalized PWid FEC).
 * Three PEs around one P router, a full mesh of three pseudowires, one customer
 * LAN 192.168.0.0/24 with a CE behind each PE. The only link between the CEs is
 * the VPLS: a bridge with MAC learning that floods unknown/broadcast, forwards
 * learned unicast, and never relays a frame from one pseudowire to another
 * (split horizon, §4.4).
 * New subsystem: all 10 cases fail before (no Generalized FEC, no engine, no frames).
 * Witnesses: PEs with different VPN ids stay unconnected (the filter is the AGI);
 * unicast between two CEs does not reach the third once learned (containment is
 * what separates forwarding from flooding).
 * The AGI type value 1 is not in the uploaded text (IANA registry).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { decodePdu, encodePdu } from '@/network/ldp/LdpCodec';
import type { GeneralizedPwFec } from '@/network/ldp/LdpMessages';
import { MplsLabel } from '@/network/mpls/MplsLabel';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function whileTimePasses<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) {
    clock.advance(100);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return work;
}

const addr = (text: string) => new IPAddress(text);

async function lab(options: { vpn3?: number } = {}) {
  const ces = [1, 2, 3].map(n => new LinuxPC('linux-pc', `CE${n}`));
  const pes = [1, 2, 3].map(n => new CiscoRouter(`PE${n}`));
  const p = new CiscoRouter('P');
  for (let i = 0; i < 3; i++) {
    new Cable(`ac${i}`).connect(ces[i].getPort('eth0')!, pes[i].getPort('GigabitEthernet0/0')!);
    new Cable(`core${i}`).connect(pes[i].getPort('GigabitEthernet0/1')!, p.getPort(`GigabitEthernet0/${i}`)!);
  }
  const loopback = (n: number) => `${n}.${n}.${n}.${n}`;
  for (let i = 0; i < 3; i++) {
    const n = i + 1;
    const routes = [...[1, 2, 3].filter(m => m !== n).map(m => `ip route ${loopback(m)} 255.255.255.255 10.${n}.0.2`), `ip route 9.9.9.9 255.255.255.255 10.${n}.0.2`];
    const links = [1, 2, 3].filter(m => m !== n).map(m => `ip route 10.${m}.0.0 255.255.255.0 10.${n}.0.2`);
    await run(pes[i], [
      'interface Loopback0', `ip address ${loopback(n)} 255.255.255.255`, 'exit',
      'interface GigabitEthernet0/0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', `ip address 10.${n}.0.1 255.255.255.0`, 'no shutdown', 'exit', ...routes, ...links,
    ]);
    await ces[i].executeCommand(`sudo ip addr add 192.168.0.${n}/24 dev eth0`);
  }
  await run(p, [
    'interface Loopback0', 'ip address 9.9.9.9 255.255.255.255', 'exit',
    ...[1, 2, 3].flatMap(n => [`interface GigabitEthernet0/${n - 1}`, `ip address 10.${n}.0.2 255.255.255.0`, 'no shutdown', 'exit']),
    ...[1, 2, 3].map(n => `ip route ${loopback(n)} 255.255.255.255 10.${n}.0.1`),
  ]);
  for (let i = 0; i < 3; i++) {
    pes[i].getLdpEngine().enableInterface('GigabitEthernet0/1');
    p.getLdpEngine().enableInterface(`GigabitEthernet0/${i}`);
  }
  clock.advance(6000);
  const vpn = [100, 100, options.vpn3 ?? 100];
  for (let i = 0; i < 3; i++) {
    const vpls = pes[i].getVplsEngine();
    vpls.define({ name: 'CUSTOMER', vpnId: vpn[i], controlWord: 'not-preferred' });
    vpls.addAttachmentCircuit('CUSTOMER', 'GigabitEthernet0/0');
    for (const m of [1, 2, 3].filter(m => m !== i + 1)) vpls.addNeighbor('CUSTOMER', addr(loopback(m)));
  }
  clock.advance(90000);
  return { ces, pes, p };
}

describe('Generalized PWid FEC and MAC List on the LDP wire', () => {
  const sender = LdpIdentifier.of(addr('1.1.1.1'), 0);
  const fec: GeneralizedPwFec = {
    kind: 'gen-pwid', controlWord: false, pwType: 5, agi: { type: 1, value: Uint8Array.of(0, 0, 0, 100) },
    saii: { type: 0, value: new Uint8Array(0) }, taii: { type: 0, value: new Uint8Array(0) },
    interfaceParameters: [{ type: 1, value: Uint8Array.of(0x05, 0xdc) }],
  };

  it('a Label Mapping carries element 0x81 with the AGI, null SAII and TAII, and the interface parameters TLV', () => {
    const bytes = encodePdu({ version: 1, sender, messages: [{ kind: 'label-mapping', id: 1, fec: [fec], label: MplsLabel.of(30), pwStatus: 0 }] });
    const decoded = decodePdu(bytes).messages[0];
    expect(decoded.kind === 'label-mapping' && decoded.fec[0]).toEqual(fec);
    expect(Array.from(bytes)).toContain(0x81);
  });

  it('an Address Withdraw with the MAC List TLV (0x0404) round-trips, empty and with addresses', () => {
    const macs = [[0x02, 0, 0, 0, 0, 1], [0x02, 0, 0, 0, 0, 2]];
    const withMacs = decodePdu(encodePdu({ version: 1, sender, messages: [{ kind: 'mac-withdraw', id: 2, fec: [{ ...fec, interfaceParameters: [] }], macs }] })).messages[0];
    const empty = decodePdu(encodePdu({ version: 1, sender, messages: [{ kind: 'mac-withdraw', id: 3, fec: [{ ...fec, interfaceParameters: [] }], macs: [] }] })).messages[0];
    expect(withMacs).toMatchObject({ kind: 'mac-withdraw', macs });
    expect(empty).toMatchObject({ kind: 'mac-withdraw', macs: [] });
  });
});

describe('a VPLS across three PEs (RFC 4762)', () => {
  it('the full mesh of pseudowires is up on every PE', async () => {
    const { pes } = await lab();
    for (const pe of pes) {
      const views = pe.getVplsEngine().neighborViews('CUSTOMER');
      expect(views).toHaveLength(2);
      expect(views.map(v => v.state)).toEqual(['up', 'up']);
    }
  });

  it('every CE reaches every other CE on the same subnet', async () => {
    const { ces } = await lab();
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('2 received');
    expect(await whileTimePasses(ces[1].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('2 received');
  });

  it('each PE learns the local CE on its attachment circuit and the remote CEs behind the right pseudowire (§4.2)', async () => {
    const { ces, pes } = await lab();
    await whileTimePasses(ces[0].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    await whileTimePasses(ces[1].executeCommand('ping -c 1 -W 1 192.168.0.1'));
    const table = pes[1].getVplsEngine().macTable('CUSTOMER');
    const mac = (ce: LinuxPC) => ce.getPort('eth0')!.getMAC().toString();
    expect(table).toContainEqual({ mac: mac(ces[0]), port: 'pw:1.1.1.1' });
    expect(table).toContainEqual({ mac: mac(ces[1]), port: 'ac:GigabitEthernet0/0' });
  });

  it('WITNESS: once the MACs are learned, a unicast between two CEs does not reach the third PE', async () => {
    const { ces, pes } = await lab();
    await whileTimePasses(ces[0].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    await whileTimePasses(ces[1].executeCommand('ping -c 1 -W 1 192.168.0.1'));
    const before = pes[2].getMplsEngine().counters.disposed;
    await whileTimePasses(ces[0].executeCommand('ping -c 3 -W 1 192.168.0.2'));
    expect(pes[2].getMplsEngine().counters.disposed).toBe(before);
  });

  it('the first ARP broadcast is flooded to the PE that has not seen the MAC yet', async () => {
    const { ces, pes } = await lab();
    const before = pes[2].getVplsEngine().counters.flooded;
    await whileTimePasses(ces[0].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    expect(pes[2].getVplsEngine().counters.flooded).toBeGreaterThan(before);
  });

  it('split horizon: a frame arriving on one pseudowire for a MAC learned on another pseudowire is dropped, not relayed (§4.4)', async () => {
    const { ces, pes } = await lab();
    await whileTimePasses(ces[2].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    const engine = pes[1].getVplsEngine();
    const ce3 = ces[2].getPort('eth0')!.getMAC();
    expect(engine.macTable('CUSTOMER')).toContainEqual({ mac: ce3.toString(), port: 'pw:3.3.3.3' });
    const dropped = engine.counters.droppedSplitHorizon;
    const sent = pes[1].getMplsEngine().counters.imposed;
    engine.egress('GigabitEthernet0/0', 'CUSTOMER|1.1.1.1', {
      type: 'pw-ethernet', controlWord: null,
      frame: { srcMAC: ces[0].getPort('eth0')!.getMAC(), dstMAC: ce3, etherType: 0x0800, payload: null },
    });
    expect(engine.counters.droppedSplitHorizon).toBe(dropped + 1);
    expect(pes[1].getMplsEngine().counters.imposed).toBe(sent);
  });

  it('an empty MAC withdrawal from a PE clears every other MAC learned by the receiver (§6.2.2)', async () => {
    const { ces, pes } = await lab();
    await whileTimePasses(ces[0].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    await whileTimePasses(ces[2].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    const mac = (ce: LinuxPC) => ce.getPort('eth0')!.getMAC().toString();
    expect(pes[1].getVplsEngine().macTable('CUSTOMER').map(e => e.mac)).toContain(mac(ces[2]));
    pes[0].getPort('GigabitEthernet0/0')!.setUp(false);
    clock.advance(1000);
    const after = pes[1].getVplsEngine().macTable('CUSTOMER').map(e => e.mac);
    expect(pes[1].getVplsEngine().counters.macWithdrawsReceived).toBeGreaterThanOrEqual(1);
    expect(after).not.toContain(mac(ces[2]));
    expect(after).toContain(mac(ces[0]));
  });

  it('WITNESS: a PE configured with another VPN id is not part of the mesh and its CE is not reachable', async () => {
    const { ces, pes } = await lab({ vpn3: 200 });
    expect(pes[2].getVplsEngine().neighborViews('CUSTOMER').map(v => v.state)).toEqual(['down', 'down']);
    expect(pes[0].getVplsEngine().neighborViews('CUSTOMER').find(v => String(v.peer) === '3.3.3.3')!.state).toBe('down');
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('0 received');
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
  });
});
