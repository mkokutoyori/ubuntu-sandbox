/**
 * Probe: Ethernet pseudowires over LDP (docs/rfc/mpls/rfc4447.txt §5.2, §5.4, §6.2;
 * docs/rfc/mpls/rfc4448.txt §4.2, §4.4, §4.6).
 * CE1 - PE1 - P - PE2 - CE2, both CEs on 192.168.0.0/24: the only thing that can
 * make CE1 reach CE2 is the pseudowire (the PEs have no IP on the attachment
 * circuits and the P router holds no pseudowire state, only transport labels).
 * New subsystem: all 11 cases fail before (no PWid FEC, no engine, no frames).
 * Witnesses that prove the lab: equal MTUs and equal control-word preference come
 * up and pass traffic, so each refusal case differs from them by one setting.
 * Interface parameter type 0x01 (MTU) is not in the uploaded text (it cites the
 * IANA registry); PW type 5 and 4, sub-TLV 0x06, status codes 0x24/0x25/0x28/0x2B
 * and TLV 0x096A are. Sequence numbers are sent as 0 (checking disabled).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { decodePdu, encodePdu } from '@/network/ldp/LdpCodec';
import { StatusCode, type PwIdFec } from '@/network/ldp/LdpMessages';

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

type Preference = 'preferred' | 'not-preferred';

async function lab(options: { cw1?: Preference; cw2?: Preference; mtu2?: number } = {}) {
  const ce1 = new LinuxPC('linux-pc', 'CE1');
  const ce2 = new LinuxPC('linux-pc', 'CE2');
  const pe1 = new CiscoRouter('PE1');
  const p = new CiscoRouter('P');
  const pe2 = new CiscoRouter('PE2');
  new Cable('a').connect(ce1.getPort('eth0')!, pe1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(pe1.getPort('GigabitEthernet0/1')!, p.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(p.getPort('GigabitEthernet0/1')!, pe2.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(pe2.getPort('GigabitEthernet0/1')!, ce2.getPort('eth0')!);
  await run(pe1, ['interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2']);
  await run(p, ['interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(pe2, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2']);
  await ce1.executeCommand('sudo ip addr add 192.168.0.1/24 dev eth0');
  await ce2.executeCommand('sudo ip addr add 192.168.0.2/24 dev eth0');
  for (const [router, iface] of [[pe1, 'GigabitEthernet0/1'], [p, 'GigabitEthernet0/0'], [p, 'GigabitEthernet0/1'], [pe2, 'GigabitEthernet0/0']] as const) {
    router.getLdpEngine().enableInterface(iface);
  }
  clock.advance(6000);
  if (options.mtu2 !== undefined) pe2.getPort('GigabitEthernet0/1')!.setMTU(options.mtu2);
  pe1.getPseudowireEngine().add({
    attachmentCircuit: 'GigabitEthernet0/0', peer: new IPAddress('3.3.3.3'), pwId: 100, controlWord: options.cw1 ?? 'not-preferred', groupId: 0,
  });
  pe2.getPseudowireEngine().add({
    attachmentCircuit: 'GigabitEthernet0/1', peer: new IPAddress('1.1.1.1'), pwId: 100, controlWord: options.cw2 ?? 'not-preferred', groupId: 0,
  });
  clock.advance(60000);
  return { ce1, ce2, pe1, p, pe2 };
}

describe('PWid FEC and PW Status on the LDP wire (RFC 4447 §5.2, §5.4)', () => {
  const sender = LdpIdentifier.of(new IPAddress('1.1.1.1'), 0);
  const fec: PwIdFec = {
    kind: 'pwid', controlWord: true, pwType: 5, groupId: 7, pwId: 100,
    interfaceParameters: [{ type: 1, value: Uint8Array.of(0x05, 0xdc) }],
  };

  it('a Label Mapping carries the PWid FEC element (0x80, C bit, type, group, id, parameters) and the PW Status TLV', () => {
    const bytes = encodePdu({ version: 1, sender, messages: [{ kind: 'label-mapping', id: 1, fec: [fec], label: MplsLabel.of(24), pwStatus: 0 }] });
    const decoded = decodePdu(bytes).messages[0];
    expect(decoded).toMatchObject({ kind: 'label-mapping', pwStatus: 0 });
    expect(decoded.kind === 'label-mapping' && decoded.fec[0]).toEqual(fec);
    expect(Array.from(bytes).join(',')).toContain('128,128');
  });

  it('a PW Status Notification carries status 0x28, the PW Status TLV and the FEC without parameters', () => {
    const wildcard: PwIdFec = { ...fec, pwId: null, interfaceParameters: [] };
    const bytes = encodePdu({ version: 1, sender, messages: [{
      kind: 'notification', id: 2, statusCode: StatusCode.PwStatus, forward: false, referencedMessageId: 0, referencedMessageType: 0,
      pwStatus: 1, fec: [wildcard],
    }] });
    expect(decodePdu(bytes).messages[0]).toMatchObject({ kind: 'notification', statusCode: 0x28, pwStatus: 1, fec: [wildcard] });
  });

  it('a Label Withdraw carries the Wrong C-bit status code', () => {
    const bytes = encodePdu({ version: 1, sender, messages: [{
      kind: 'label-withdraw', id: 3, fec: [{ ...fec, interfaceParameters: [] }], label: MplsLabel.of(24), status: StatusCode.WrongCBit,
    }] });
    expect(decodePdu(bytes).messages[0]).toMatchObject({ kind: 'label-withdraw', status: 0x25 });
  });
});

describe('an Ethernet pseudowire between two PEs (RFC 4447, RFC 4448)', () => {
  it('both PEs exchange label mappings over a targeted session and the pseudowire is up', async () => {
    const { pe1, pe2 } = await lab();
    const view1 = pe1.getPseudowireEngine().views()[0];
    const view2 = pe2.getPseudowireEngine().views()[0];
    expect(view1).toMatchObject({ state: 'up', pwId: 100, pwType: 5, controlWord: false, reason: null });
    expect(view2).toMatchObject({ state: 'up', controlWord: false });
    expect(view1.remoteLabel!.equals(view2.localLabel!)).toBe(true);
    expect(view2.remoteLabel!.equals(view1.localLabel!)).toBe(true);
  });

  it('CE1 reaches CE2 on the same subnet through the pseudowire; P switches transport labels and holds no pseudowire state', async () => {
    const { ce1, p, pe1, pe2 } = await lab();
    const before = p.getMplsEngine().counters.labelledIn;
    const out = await whileTimePasses(ce1.executeCommand('ping -c 3 -W 1 192.168.0.2'));
    expect(out).toContain('3 received');
    expect(pe1.getPseudowireEngine().counters.encapsulated).toBeGreaterThanOrEqual(3);
    expect(pe2.getPseudowireEngine().counters.decapsulated).toBeGreaterThanOrEqual(3);
    expect(p.getMplsEngine().counters.labelledIn - before).toBeGreaterThanOrEqual(6);
    expect(p.getMplsEngine().lfib.ilmEntries().some(([, entry]) => entry.kind === 'pw')).toBe(false);
  });

  it('WITNESS: with no pseudowire the same lab does not connect the CEs', async () => {
    const { ce1, pe1 } = await lab();
    pe1.getPseudowireEngine().remove('GigabitEthernet0/0');
    clock.advance(2000);
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'));
    expect(out).toContain('0 received');
  });

  it('both ends prefer the control word: it is used and traffic still passes', async () => {
    const { ce1, pe1, pe2 } = await lab({ cw1: 'preferred', cw2: 'preferred' });
    expect(pe1.getPseudowireEngine().views()[0]).toMatchObject({ state: 'up', controlWord: true });
    expect(pe2.getPseudowireEngine().views()[0].controlWord).toBe(true);
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'));
    expect(out).toContain('2 received');
  });

  it('one end prefers the control word and the other does not: it is not used (RFC 4447 §6.2 iii) and traffic passes', async () => {
    const { ce1, pe1, pe2 } = await lab({ cw1: 'preferred', cw2: 'not-preferred' });
    expect(pe1.getPseudowireEngine().views()[0]).toMatchObject({ state: 'up', controlWord: false });
    expect(pe2.getPseudowireEngine().views()[0]).toMatchObject({ state: 'up', controlWord: false });
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'));
    expect(out).toContain('2 received');
  });

  it('different attachment circuit MTUs keep the pseudowire down (RFC 4447 §5.5)', async () => {
    const { pe1, pe2 } = await lab({ mtu2: 1400 });
    expect(pe1.getPseudowireEngine().views()[0]).toMatchObject({ state: 'down', reason: 'interface MTU mismatch' });
    expect(pe2.getPseudowireEngine().views()[0]).toMatchObject({ state: 'down', reason: 'interface MTU mismatch' });
  });

  it('the attachment circuit going down is signalled with a PW Status notification and the peer stops forwarding', async () => {
    const { ce1, pe1, pe2 } = await lab();
    pe1.getPort('GigabitEthernet0/0')!.setUp(false);
    clock.advance(1000);
    expect(pe2.getPseudowireEngine().views()[0]).toMatchObject({ state: 'down', reason: 'peer reports the pseudowire not forwarding' });
    expect(pe1.getPseudowireEngine().views()[0]).toMatchObject({ state: 'down', reason: 'attachment circuit down' });
    pe1.getPort('GigabitEthernet0/0')!.setUp(true);
    clock.advance(1000);
    expect(pe2.getPseudowireEngine().views()[0].state).toBe('up');
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'));
    expect(out).toContain('2 received');
  });

  it('deleting the pseudowire withdraws the label and the peer drops its remote binding', async () => {
    const { pe1, pe2 } = await lab();
    pe1.getPseudowireEngine().remove('GigabitEthernet0/0');
    clock.advance(1000);
    expect(pe2.getPseudowireEngine().views()[0]).toMatchObject({ state: 'down', remoteLabel: null });
  });
});
