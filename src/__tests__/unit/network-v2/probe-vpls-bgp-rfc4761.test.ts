/**
 * Probe: BGP-signalled VPLS (docs/rfc/mpls/rfc4761.txt §3.2 NLRI, §3.2.2 Layer2 Info
 * extended community, §3.2.4 label blocks, §3.5 route-target import, §4 BGP as discovery
 * and signalling, §4.1 forwarding).
 * Three PEs around one P router, an iBGP full mesh on the loopbacks carrying AFI 25 /
 * SAFI 65, one customer LAN 192.168.0.0/24 with a CE behind each PE. There is no LDP
 * pseudowire: each PE allocates a contiguous label block and a remote PE derives the
 * label to use as LB + (own VE-ID - VBO).
 * New subsystem (no AFI 25 family, no NLRI, no label block): all 9 cases fail before.
 * Witnesses: a PE with a different route target stays out of the VPLS and its CE is
 * unreachable (the filter is the RT, not the BGP session); a VE-ID outside the remote
 * label block brings the pseudowire down on both sides rather than sending on a
 * wrong label.
 * IANA values used and absent from the uploaded text: AFI 25, SAFI 65 and the Layer2
 * Info extended-community type 0x800A come from the RFC body (§3.1, §3.2.2); the
 * encapsulation type 19 is the one the RFC assigns to VPLS (§3.2.2).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

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

const loopback = (n: number) => `${n}.${n}.${n}.${n}`;

interface LabOptions {
  readonly routeTargets?: readonly string[];
  readonly veIds?: readonly number[];
  readonly controlWord?: 'preferred' | 'not-preferred';
}

async function lab(options: LabOptions = {}) {
  const routeTargets = options.routeTargets ?? ['65000:100', '65000:100', '65000:100'];
  const veIds = options.veIds ?? [1, 2, 3];
  const ces = [1, 2, 3].map(n => new LinuxPC('linux-pc', `CE${n}`));
  const pes = [1, 2, 3].map(n => new CiscoRouter(`PE${n}`));
  const p = new CiscoRouter('P');
  for (let i = 0; i < 3; i++) {
    new Cable(`ac${i}`).connect(ces[i].getPort('eth0')!, pes[i].getPort('GigabitEthernet0/0')!);
    new Cable(`core${i}`).connect(pes[i].getPort('GigabitEthernet0/1')!, p.getPort(`GigabitEthernet0/${i}`)!);
  }
  for (let i = 0; i < 3; i++) {
    const n = i + 1;
    const others = [1, 2, 3].filter(m => m !== n);
    await run(pes[i], [
      'interface Loopback0', `ip address ${loopback(n)} 255.255.255.255`, 'exit',
      'interface GigabitEthernet0/0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', `ip address 10.${n}.0.1 255.255.255.0`, 'no shutdown', 'exit',
      ...others.map(m => `ip route ${loopback(m)} 255.255.255.255 10.${n}.0.2`),
      'ip route 9.9.9.9 255.255.255.255 10.' + n + '.0.2',
      ...others.map(m => `ip route 10.${m}.0.0 255.255.255.0 10.${n}.0.2`),
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
  for (let i = 0; i < 3; i++) {
    const n = i + 1;
    const vpls = pes[i].getVplsEngine();
    vpls.defineBgp({
      name: 'CUSTOMER', vpnId: 100, controlWord: options.controlWord ?? 'not-preferred',
      rd: `65000:${n}`, routeTarget: routeTargets[i], veId: veIds[i], veBlockSize: 8,
    });
    vpls.addAttachmentCircuit('CUSTOMER', 'GigabitEthernet0/0');
    await run(pes[i], ['router bgp 65000']);
    for (const m of [1, 2, 3].filter(m => m !== n)) {
      pes[i].getBGPEngine().getConfig().neighbors.set(loopback(m), {
        ip: loopback(m), remoteAs: 65000, activated: true, updateSource: 'Loopback0', vpls: true,
      });
    }
    pes[i].convergeDynamicRouting();
  }
  for (let round = 0; round < 3; round++) {
    for (const pe of pes) pe.convergeDynamicRouting();
    clock.advance(10000);
  }
  return { ces, pes, p };
}

describe('BGP-signalled VPLS across three PEs (RFC 4761)', () => {
  it('the iBGP sessions negotiate AFI 25 / SAFI 65 and each PE receives the NLRI of the two others (§3.2, §4)', async () => {
    const { pes } = await lab();
    expect(pes[0].getBGPEngine().vplsBgpSpeaker()!.receivedCount('2.2.2.2')).toBe(1);
    expect(pes[0].getBGPEngine().vplsBgpSpeaker()!.receivedCount('3.3.3.3')).toBe(1);
  });

  it('the local label block is contiguous and every label of it is a VPLS pseudowire entry (§3.2.4)', async () => {
    const { pes } = await lab();
    const entries = pes[0].getMplsEngine().lfib.ilmEntries().filter(([, e]) => e.kind === 'pw');
    expect(entries).toHaveLength(8);
    const base = entries[0][0].value;
    entries.forEach(([label, entry], index) => {
      expect(label.value).toBe(base + index);
      expect(entry).toMatchObject({ kind: 'pw', owner: 'vpls', endpoint: `CUSTOMER|ve:${index + 1}` });
    });
  });

  it('a remote PE sends with LB + (own VE-ID - VBO): PE1 reaches PE2 on PE2 block base + 0 and PE2 reaches PE1 on PE1 block base + 1 (§3.2.4)', async () => {
    const { pes } = await lab();
    const blockBase = (pe: CiscoRouter) => pe.getMplsEngine().lfib.ilmEntries().find(([, e]) => e.kind === 'pw')![0].value;
    const toPe2 = pes[0].getVplsEngine().neighborViews('CUSTOMER').find(v => String(v.peer) === '2.2.2.2')!;
    const toPe1 = pes[1].getVplsEngine().neighborViews('CUSTOMER').find(v => String(v.peer) === '1.1.1.1')!;
    expect(toPe2.remoteLabel!.value).toBe(blockBase(pes[1]) + 0);
    expect(toPe1.remoteLabel!.value).toBe(blockBase(pes[0]) + 1);
  });

  it('the full mesh of pseudowires is up on every PE and every CE reaches every other CE', async () => {
    const { ces, pes } = await lab();
    for (const pe of pes) expect(pe.getVplsEngine().neighborViews('CUSTOMER').map(v => v.state)).toEqual(['up', 'up']);
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('2 received');
    expect(await whileTimePasses(ces[1].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('2 received');
  });

  it('the Layer2 Info control-word flag is honoured: with C set on every PE the CEs still communicate (§3.2.2)', async () => {
    const { ces } = await lab({ controlWord: 'preferred' });
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('2 received');
  });

  it('each PE learns the remote CE behind the pseudowire to the PE that advertised it (§4.1)', async () => {
    const { ces, pes } = await lab();
    await whileTimePasses(ces[0].executeCommand('ping -c 1 -W 1 192.168.0.2'));
    const table = pes[0].getVplsEngine().macTable('CUSTOMER');
    expect(table).toContainEqual({ mac: ces[1].getPort('eth0')!.getMAC().toString(), port: 'pw:2.2.2.2' });
  });

  it('WITNESS: a PE with another route target is not imported, so its CE is unreachable while the other two still communicate (§3.5)', async () => {
    const { ces, pes } = await lab({ routeTargets: ['65000:100', '65000:100', '65000:999'] });
    expect(pes[0].getVplsEngine().neighborViews('CUSTOMER').map(v => String(v.peer))).toEqual(['2.2.2.2']);
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
    expect(await whileTimePasses(ces[0].executeCommand('ping -c 2 -W 1 192.168.0.3'))).toContain('0 received');
  });

  it('WITNESS: a VE-ID outside the remote label block brings the pseudowire down on both sides (§3.2.4)', async () => {
    const { pes } = await lab({ veIds: [1, 2, 12] });
    const toPe3 = pes[0].getVplsEngine().neighborViews('CUSTOMER').find(v => String(v.peer) === '3.3.3.3')!;
    const toPe1 = pes[2].getVplsEngine().neighborViews('CUSTOMER').find(v => String(v.peer) === '1.1.1.1')!;
    expect(toPe3.state).toBe('down');
    expect(toPe1.state).toBe('down');
    expect(pes[0].getVplsEngine().neighborViews('CUSTOMER').find(v => String(v.peer) === '2.2.2.2')!.state).toBe('up');
  });

  it('losing the iBGP session withdraws the remote VE: the pseudowire disappears from the neighbour list (§4)', async () => {
    const { pes } = await lab();
    await run(pes[1], ['interface GigabitEthernet0/1', 'shutdown']);
    clock.advance(400000);
    expect(pes[0].getVplsEngine().neighborViews('CUSTOMER').map(v => String(v.peer))).toEqual(['3.3.3.3']);
  });
});
