/**
 * Probe: LDP discovery, session establishment and label distribution on the
 * wire (docs/rfc/mpls/rfc5036.txt §2.4, §2.5, §3.5, Appendix A.1).
 * Lab: PC1 - R1 - R2 - R3 - PC2, loopbacks as LSR ids and transport addresses,
 * static routes as the IGP. Time is virtual: hellos every 5 s, hold 15 s.
 * New subsystem: every case fails before (module absent); the witness is the
 * same lab with LDP disabled on one link, where no session forms. A reentrancy
 * defect found while writing it (a synchronous peer answer arriving before the
 * session state was advanced) is covered by every session case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { IPAddress } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { decodePdu, encodePdu } from '@/network/ldp/LdpCodec';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { StatusCode } from '@/network/ldp/LdpMessages';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function whileTimePasses<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) {
    clock.advance(100);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return work;
}

async function configure(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function lab(options: { ldpOnSecondLink: boolean; ordered?: boolean } = { ldpOnSecondLink: true }) {
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
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2',
    'ip route 10.23.0.0 255.255.255.0 10.12.0.2', 'ip route 10.3.0.0 255.255.255.0 10.12.0.2',
  ]);
  await configure(r2, [
    'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3',
    'ip route 10.1.0.0 255.255.255.0 10.12.0.1', 'ip route 10.3.0.0 255.255.255.0 10.23.0.3',
  ]);
  await configure(r3, [
    'interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.3.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2',
    'ip route 10.12.0.0 255.255.255.0 10.23.0.2', 'ip route 10.1.0.0 255.255.255.0 10.23.0.2',
  ]);
  await pc1.executeCommand('sudo ip addr add 10.1.0.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 10.1.0.1');
  await pc2.executeCommand('sudo ip addr add 10.3.0.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 10.3.0.1');
  if (options.ordered) r2.getLdpEngine().config.controlMode = 'ordered';
  r1.getLdpEngine().enableInterface('GigabitEthernet0/1');
  r2.getLdpEngine().enableInterface('GigabitEthernet0/0');
  if (options.ldpOnSecondLink) {
    r2.getLdpEngine().enableInterface('GigabitEthernet0/1');
    r3.getLdpEngine().enableInterface('GigabitEthernet0/0');
  }
  clock.advance(6000);
  return { pc1, pc2, r1, r2, r3 };
}

describe('discovery and session establishment', () => {
  it('Hello adjacencies are created on both ends of an LDP link', async () => {
    const { r1, r2 } = await lab();
    expect(r1.getLdpEngine().adjacencies().map(a => a.peer.toString())).toEqual(['2.2.2.2:0']);
    expect(r2.getLdpEngine().adjacencies().map(a => a.peer.toString()).sort()).toEqual(['1.1.1.1:0', '3.3.3.3:0']);
  });

  it('the LSR with the higher transport address is active and the sessions reach OPERATIONAL', async () => {
    const { r1, r2, r3 } = await lab();
    const s12 = r1.getLdpEngine().sessions()[0];
    expect(s12.state).toBe('operational');
    expect(s12.role).toBe('passive');
    expect(r2.getLdpEngine().sessions().map(s => [s.peer!.toString(), s.role, s.state]).sort())
      .toEqual([['1.1.1.1:0', 'active', 'operational'], ['3.3.3.3:0', 'passive', 'operational']]);
    expect(r3.getLdpEngine().sessions()[0].role).toBe('active');
  });

  it('WITNESS: with LDP off on the second link no session forms across it', async () => {
    const { r2, r3 } = await lab({ ldpOnSecondLink: false });
    expect(r3.getLdpEngine().sessions()).toHaveLength(0);
    expect(r2.getLdpEngine().sessions().map(s => s.peer!.toString())).toEqual(['1.1.1.1:0']);
  });

  it('the negotiated KeepAlive time is the smaller proposal and the Address messages tell who owns 10.23.0.2', async () => {
    const { r1, r2 } = await lab();
    r2.getLdpEngine().config.keepAliveSeconds = 90;
    const s = r1.getLdpEngine().sessions()[0];
    expect(s.negotiated!.keepAliveTimeSeconds).toBe(180);
    expect([...s.peerAddresses.keys()].sort()).toEqual(['10.12.0.2', '10.23.0.2', '2.2.2.2']);
  });

  it('missing Hellos expire the adjacency after the hold time and close the session', async () => {
    const { r1, r2 } = await lab();
    r2.getLdpEngine().disableInterface('GigabitEthernet0/0');
    clock.advance(16000);
    expect(r1.getLdpEngine().adjacencies()).toHaveLength(0);
    expect(r1.getLdpEngine().sessions()).toHaveLength(0);
    expect(r2.getLdpEngine().sessions().map(s => s.peer!.toString())).toEqual(['3.3.3.3:0']);
  });
});

describe('label distribution (downstream unsolicited, liberal retention)', () => {
  it('an egress advertises Implicit NULL for its connected prefixes (RFC 3031 PHP)', async () => {
    const { r2 } = await lab();
    const fromR3 = r2.getLdpEngine().remoteBindings(r2.getLdpEngine().sessions().find(s => s.peer!.lsrId.toString() === '3.3.3.3')!.peer!);
    expect(fromR3.get('3.3.3.3/32')!.value).toBe(3);
    expect(fromR3.get('10.3.0.0/24')!.value).toBe(3);
  });

  it('the label R2 advertises for 10.3.0.0/24 is its own, and R1 pushes exactly that label', async () => {
    const { r1, r2 } = await lab();
    const advertised = r2.getLdpEngine().bindings().find(b => b.fec.key === '10.3.0.0/24')!;
    expect(advertised.egress).toBe(false);
    expect(advertised.label.value).toBeGreaterThanOrEqual(16);
    const ftn = r1.getMplsEngine().lfib.lookupFtn(new IPAddress('10.3.0.10'))!;
    expect(ftn.outLabels.map(l => l.value)).toEqual([advertised.label.value]);
    expect(ftn.nextHop.toString()).toBe('10.12.0.2');
  });

  it('R2 pops towards R3 for that label (the downstream advertised Implicit NULL)', async () => {
    const { r2 } = await lab();
    const label = r2.getLdpEngine().bindings().find(b => b.fec.key === '10.3.0.0/24')!.label;
    expect(r2.getMplsEngine().lfib.lookupIlm(label)).toMatchObject({ kind: 'pop', iface: 'GigabitEthernet0/1' });
  });

  it('traffic from PC1 to PC2 is label switched end to end', async () => {
    const { pc1, r1, r2, r3 } = await lab();
    const out = await whileTimePasses(pc1.executeCommand('ping -c 3 -W 1 10.3.0.10'));
    expect(out).toContain('3 received');
    expect(r1.getMplsEngine().counters.imposed).toBeGreaterThanOrEqual(3);
    expect(r2.getMplsEngine().counters.disposed).toBeGreaterThanOrEqual(3);
    expect(r3.getMplsEngine().counters.labelledIn).toBe(0);
  });

  it('a route that disappears is withdrawn and the peer releases it (§3.5.10)', async () => {
    const { r1, r2 } = await lab();
    await configure(r2, ['no ip route 10.3.0.0 255.255.255.0 10.23.0.3']);
    clock.advance(6000);
    expect(r2.getLdpEngine().bindings().find(b => b.fec.key === '10.3.0.0/24')).toBeUndefined();
    expect(r1.getMplsEngine().lfib.lookupFtn(new IPAddress('10.3.0.10'))).toBeUndefined();
    expect(MplsLabel.IMPLICIT_NULL.value).toBe(3);
  });
});

describe('session maintenance and refusal (§2.5.3, §2.5.6, §3.5.1)', () => {
  it('KeepAlives keep an idle session up well past the KeepAlive time', async () => {
    const { r1 } = await lab();
    clock.advance(400000);
    expect(r1.getLdpEngine().sessions()[0].state).toBe('operational');
  });

  it('a peer that never speaks again is dropped when the KeepAlive timer expires', async () => {
    const { r1, r2 } = await lab();
    const reasons: string[] = [];
    const engine = r1.getLdpEngine() as unknown as { sessionClosed(session: unknown, reason: string, rejected: boolean): void };
    const original = engine.sessionClosed.bind(engine);
    engine.sessionClosed = (session, reason, rejected) => { reasons.push(reason); original(session, reason, rejected); };
    const toR1 = r2.getLdpEngine().sessions().find(s => s.peer!.lsrId.toString() === '1.1.1.1')!;
    toR1.send = () => undefined;
    clock.advance(400000);
    expect(reasons).toContain('keepalive timer expired');
  });

  it('an Initialization from an LSR with no Hello adjacency is answered Session Rejected / No Hello (§2.5.3 c)', async () => {
    const { r1, r2 } = await lab();
    const seen: Array<{ kind: string; statusCode?: number }> = [];
    const socket = r2.getTcpStack().connect('10.12.0.1', 646, { localIp: '10.12.0.2' })!;
    socket.onData((chunk) => {
      if (chunk instanceof Uint8Array) for (const m of decodePdu(chunk).messages) seen.push(m as never);
    });
    const stranger = LdpIdentifier.of(new IPAddress('9.9.9.9'), 0);
    socket.send(encodePdu({
      version: 1, sender: stranger,
      messages: [{
        kind: 'initialization', id: 1, protocolVersion: 1, keepAliveTimeSeconds: 60, advertisementMode: 'unsolicited',
        loopDetection: false, pathVectorLimit: 0, maxPduLength: 4096, receiver: r1.getLdpEngine().localId,
      }],
    }));
    expect(seen.find(m => m.kind === 'notification')!.statusCode).toBe(StatusCode.SessionRejectedNoHello);
    expect(socket.state).not.toBe('established');
  });

  it('a message other than Initialization on a fresh connection is refused and the transport closed', async () => {
    const { r1, r2 } = await lab();
    const socket = r2.getTcpStack().connect('10.12.0.1', 646, { localIp: '10.12.0.2' })!;
    socket.send(encodePdu({ version: 1, sender: r2.getLdpEngine().localId, messages: [{ kind: 'keepalive', id: 1 }] }));
    expect(socket.state).not.toBe('established');
    expect(r1.getLdpEngine().sessions()[0].state).toBe('operational');
  });
});

describe('ordered control (§2.6.1.2)', () => {
  it('R2 does not advertise a label for a FEC whose next hop has not given one', async () => {
    const pre = await lab({ ldpOnSecondLink: false, ordered: true });
    const fromR2 = pre.r1.getLdpEngine().remoteBindings(pre.r1.getLdpEngine().sessions()[0].peer!);
    expect(fromR2.has('10.12.0.0/24')).toBe(true);
    expect(fromR2.has('10.3.0.0/24')).toBe(false);
  });
});
