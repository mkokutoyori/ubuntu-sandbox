/**
 * Probe: MPLS LSP ping (docs/rfc/mpls/rfc8029.txt §3, §4.3-§4.6).
 * Codec cases pin the wire layout (the RFC's own FEC Stack example has Length 32);
 * the responder cases drive §4.4 with a stub ILM; the lab cases send real echo
 * requests over the wire R1 - R2 - R3 and L3VPN PE1 - P - PE2, labelled by the LFIB.
 * New subsystem: all 23 cases fail before (the modules do not exist). None passes
 * either way. The WITNESS cases (a FEC with no label binding is not sent; a
 * reply-mode-1 request gets no reply) are what prove the lab is sound once the
 * engine exists: a missing reply there is a refusal, not a broken lab.
 * Interpretation recorded: on success the Return Subcode is the index of the last
 * FEC validated; Label-L at the egress is the label actually popped (the RFC text
 * resets it to Implicit Null, which would fail every VPN FEC).
 * Not built: Downstream Detailed Mapping (type 20) is refused with code 2 and
 * echoed in Errored TLVs, never stored and ignored (TODO.md).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import {
  EchoMessageType, EchoTlvType, GlobalFlag, type TargetFec, PadInstruction, ReplyMode, ReturnCode, decodeEcho, encodeEcho, newEchoMessage,
} from '@/network/mpls/oam/EchoCodec';
import { evaluateEchoRequest, type EchoResponderHost } from '@/network/mpls/oam/EchoResponder';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

const ldp = (prefix: string, length = 32) => ({ kind: 'ldp-ipv4' as const, prefix: new IPAddress(prefix), length });

async function chain() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  await run(r1, ['interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2']);
  await run(r2, ['interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(r3, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2']);
  for (const [router, iface] of [[r1, 'GigabitEthernet0/0'], [r2, 'GigabitEthernet0/0'], [r2, 'GigabitEthernet0/1'], [r3, 'GigabitEthernet0/0']] as const) {
    router.getLdpEngine().enableInterface(iface);
  }
  clock.advance(6000);
  return { r1, r2, r3 };
}

describe('echo message codec (§3)', () => {
  it('encodes the header, an LDP + VPN FEC stack of Length 32 and round-trips', () => {
    const message = newEchoMessage({
      messageType: EchoMessageType.Request, senderHandle: 7, sequenceNumber: 9, globalFlags: GlobalFlag.ValidateFecStack,
      targetFecs: [ldp('192.0.2.1'), { kind: 'vpn-ipv4', routeDistinguisher: '65000:1', prefix: new IPAddress('203.0.113.0'), length: 24 }],
    });
    const bytes = encodeEcho(message);
    expect(bytes.length).toBe(32 + 4 + 32);
    expect([bytes[32], bytes[33], bytes[34], bytes[35]]).toEqual([0, 1, 0, 32]);
    const decoded = decodeEcho(bytes);
    expect(decoded.targetFecs).toEqual(message.targetFecs);
    expect(decoded).toMatchObject({ version: 1, messageType: 1, replyMode: 2, senderHandle: 7, sequenceNumber: 9, globalFlags: 1 });
  });

  it('a mandatory TLV the receiver does not know is collected; an optional one is ignored', () => {
    const bytes = encodeEcho(newEchoMessage({ messageType: 1, senderHandle: 1, sequenceNumber: 1, targetFecs: [ldp('1.1.1.1')] }));
    const mandatory = Uint8Array.from([0, 20, 0, 4, 1, 2, 3, 4]);
    const optional = Uint8Array.from([0x80, 1, 0, 4, 9, 9, 9, 9]);
    const joined = new Uint8Array(bytes.length + 16);
    joined.set(bytes); joined.set(mandatory, bytes.length); joined.set(optional, bytes.length + 8);
    const decoded = decodeEcho(joined);
    expect(decoded.unrecognisedMandatory.map(tlv => tlv.type)).toEqual([EchoTlvType.DownstreamDetailedMapping]);
  });

  it('refuses a message shorter than the fixed header', () => {
    expect(() => decodeEcho(new Uint8Array(20))).toThrow();
  });
});

describe('receiving an echo request (§4.4) against a stub ILM', () => {
  const noMapping = { present: false, label: null, protocolOnInterface: true };
  function host(over: Partial<EchoResponderHost> = {}): EchoResponderHost {
    return { ilm: () => undefined, mplsEnabled: () => true, fecMapping: () => noMapping, ...over };
  }
  const receipt = (labels: number[], topTtl: number | null = null) => ({
    interfaceName: 'g0', routerAddress: new IPAddress('3.3.3.3'), interfaceAddress: new IPAddress('10.0.0.3'), labels, topTtl,
  });
  const request = (fecs: TargetFec[] = [ldp('3.3.3.3')], flags = 0) => newEchoMessage({ messageType: 1, senderHandle: 1, sequenceNumber: 1, targetFecs: fecs, globalFlags: flags });

  it('unlabelled arrival of an LDP FEC mapped to Implicit Null: egress, code 3 subcode 1', () => {
    const verdict = evaluateEchoRequest(request(), receipt([]), host({ fecMapping: () => ({ present: true, label: 3, protocolOnInterface: true }) }));
    expect(verdict).toMatchObject({ reply: true, returnCode: ReturnCode.Egress, returnSubcode: 1 });
  });

  it('no mapping for the FEC at the egress: code 4', () => {
    expect(evaluateEchoRequest(request(), receipt([]), host())).toMatchObject({ returnCode: ReturnCode.NoMapping, returnSubcode: 1 });
  });

  it('the FEC is mapped to another label than the one popped: code 10', () => {
    const verdict = evaluateEchoRequest(request(), receipt([100]), host({
      ilm: () => ({ kind: 'pop', iface: null, nextHop: null }),
      fecMapping: () => ({ present: true, label: 200, protocolOnInterface: true }),
    }));
    expect(verdict).toMatchObject({ returnCode: ReturnCode.MappingIsNotTheLabel });
  });

  it('a label with no ILM entry: code 11 at the stack depth', () => {
    expect(evaluateEchoRequest(request(), receipt([300, 400]), host())).toMatchObject({ returnCode: ReturnCode.NoLabelEntry, returnSubcode: 2 });
  });

  it('a swapped label: code 8 at the stack depth, or 9 when the output interface is not MPLS', () => {
    const entry = { kind: 'swap' as const, outLabels: [MplsLabel.of(500)], iface: 'g1', nextHop: new IPAddress('10.0.0.9') };
    expect(evaluateEchoRequest(request(), receipt([300]), host({ ilm: () => entry }))).toMatchObject({ returnCode: ReturnCode.Switched, returnSubcode: 1 });
    expect(evaluateEchoRequest(request(), receipt([300]), host({ ilm: () => entry, mplsEnabled: () => false })))
      .toMatchObject({ returnCode: ReturnCode.SwitchedNoMplsForwarding, returnSubcode: 1 });
  });

  it('the protocol of the FEC is not run on the receiving interface: code 12', () => {
    const verdict = evaluateEchoRequest(request(), receipt([]), host({ fecMapping: () => ({ present: true, label: 3, protocolOnInterface: false }) }));
    expect(verdict).toMatchObject({ returnCode: ReturnCode.ProtocolNotAssociated });
  });

  it('the T flag drops a request whose top label TTL is above 1, and answers at TTL 1', () => {
    const swap = { kind: 'swap' as const, outLabels: [MplsLabel.of(500)], iface: 'g1', nextHop: new IPAddress('10.0.0.9') };
    const flagged = request([ldp('3.3.3.3')], GlobalFlag.RespondOnlyIfTtlExpired);
    expect(evaluateEchoRequest(flagged, receipt([300], 5), host({ ilm: () => swap }))).toEqual({ reply: false });
    expect(evaluateEchoRequest(flagged, receipt([300], 1), host({ ilm: () => swap }))).toMatchObject({ reply: true, returnCode: ReturnCode.Switched });
  });

  it('an unknown mandatory TLV: code 2 with the offending TLV echoed', () => {
    const message = { ...request(), unrecognisedMandatory: [{ type: 20, value: Uint8Array.from([1, 2, 3, 4]) }] };
    const verdict = evaluateEchoRequest(message, receipt([]), host());
    expect(verdict).toMatchObject({ returnCode: ReturnCode.TlvNotUnderstood, erroredTlvs: [{ type: 20 }] });
  });

  it('a Nil FEC on top skips validation (§4.4.1)', () => {
    const verdict = evaluateEchoRequest(request([{ kind: 'nil', label: 0 }, ldp('3.3.3.3')]), receipt([]), host());
    expect(verdict).toMatchObject({ returnCode: ReturnCode.Egress });
  });
});

describe('LSP ping on the wire: R1 - R2 - R3 with LDP', () => {
  it('R1 pings the LDP FEC of R3 across R2: the egress answers code 3 (Egress) and the request crossed R2 as a labelled frame', async () => {
    const { r1, r2 } = await chain();
    const before = r2.getMplsEngine().counters.labelledIn;
    const outcome = r1.getMplsOam().ping([ldp('3.3.3.3')]);
    expect(outcome.kind).toBe('reply');
    if (outcome.kind !== 'reply') return;
    expect(outcome.reply.message).toMatchObject({ messageType: EchoMessageType.Reply, returnCode: ReturnCode.Egress, returnSubcode: 1 });
    expect(String(outcome.reply.from)).toBe('3.3.3.3');
    expect(r2.getMplsEngine().counters.labelledIn - before).toBe(1);
  });

  it('the reply carries the sender handle, the sequence number and both timestamps', async () => {
    const { r1 } = await chain();
    const outcome = r1.getMplsOam().ping([ldp('3.3.3.3')]);
    if (outcome.kind !== 'reply') throw new Error('no reply');
    expect(outcome.reply.message.senderHandle).toBeGreaterThan(0);
    expect(outcome.reply.message.timestampSent).not.toBe(0n);
    expect(outcome.reply.message.timestampReceived).not.toBe(0n);
    expect(outcome.reply.roundTripMs).toBeGreaterThanOrEqual(0);
  });

  it('a request with the MPLS TTL of 1 expires at R2 and R2 answers code 8 (Label switched at depth 1)', async () => {
    const { r1 } = await chain();
    const outcome = r1.getMplsOam().ping([ldp('3.3.3.3')], { ttl: 1 });
    if (outcome.kind !== 'reply') throw new Error('no reply');
    expect(outcome.reply.message).toMatchObject({ returnCode: ReturnCode.Switched, returnSubcode: 1 });
    expect(String(outcome.reply.from)).toBe('2.2.2.2');
  });

  it('the neighbour: pinging the loopback of R2 (penultimate hop popping, unlabelled) is answered code 3', async () => {
    const { r1 } = await chain();
    const outcome = r1.getMplsOam().ping([ldp('2.2.2.2')]);
    if (outcome.kind !== 'reply') throw new Error('no reply');
    expect(outcome.reply.message.returnCode).toBe(ReturnCode.Egress);
  });

  it('Pad TLV: instruction 2 is copied to the reply, instruction 1 is dropped', async () => {
    const { r1 } = await chain();
    const copied = r1.getMplsOam().ping([ldp('3.3.3.3')], { pad: { instruction: PadInstruction.CopyToReply, length: 40 } });
    const dropped = r1.getMplsOam().ping([ldp('3.3.3.3')], { pad: { instruction: PadInstruction.DropFromReply, length: 40 } });
    if (copied.kind !== 'reply' || dropped.kind !== 'reply') throw new Error('no reply');
    expect(copied.reply.message.pad).toMatchObject({ instruction: 2, length: 40 });
    expect(dropped.reply.message.pad).toBeNull();
  });

  it('WITNESS: reply mode 1 (do not reply) gets no reply, so a reply elsewhere is the responder\'s doing', async () => {
    const { r1 } = await chain();
    expect(r1.getMplsOam().ping([ldp('3.3.3.3')], { replyMode: ReplyMode.NoReply }).kind).toBe('timeout');
  });

  it('reply mode 4 (application control channel) gets no UDP reply: no such channel exists here', async () => {
    const { r1 } = await chain();
    expect(r1.getMplsOam().ping([ldp('3.3.3.3')], { replyMode: ReplyMode.ApplicationChannel }).kind).toBe('timeout');
  });

  it('WITNESS: a FEC with no label binding is not sent', async () => {
    const { r1 } = await chain();
    expect(r1.getMplsOam().ping([ldp('9.9.9.9')])).toEqual({ kind: 'not-sent', reason: 'no-label-binding' });
  });

  it('the reply port is released after the exchange', async () => {
    const { r1 } = await chain();
    const outcome = r1.getMplsOam().ping([ldp('3.3.3.3')]);
    if (outcome.kind !== 'reply') throw new Error('no reply');
    const second = r1.getMplsOam().ping([ldp('3.3.3.3')]);
    if (second.kind !== 'reply') throw new Error('no reply');
    expect(second.reply.message.sequenceNumber).toBeGreaterThan(outcome.reply.message.sequenceNumber);
  });
});

describe('LSP ping of a VPN-IPv4 prefix (§3.2.5): PE1 - P - PE2', () => {
  async function vpnLab() {
    const pe1 = new CiscoRouter('PE1');
    const p = new CiscoRouter('P');
    const pe2 = new CiscoRouter('PE2');
    new Cable('a').connect(new LinuxPC('linux-pc', 'CE1').getPort('eth0')!, pe1.getPort('GigabitEthernet0/0')!);
    new Cable('d').connect(pe2.getPort('GigabitEthernet0/1')!, new LinuxPC('linux-pc', 'CE2').getPort('eth0')!);
    new Cable('b').connect(pe1.getPort('GigabitEthernet0/1')!, p.getPort('GigabitEthernet0/0')!);
    new Cable('c').connect(p.getPort('GigabitEthernet0/1')!, pe2.getPort('GigabitEthernet0/0')!);
    await run(pe1, [
      'ip vrf RED', 'rd 65000:1', 'route-target export 65000:1', 'route-target import 65000:1', 'exit',
      'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
      'interface GigabitEthernet0/0', 'ip vrf forwarding RED', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2',
    ]);
    await run(p, [
      'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
      'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3',
    ]);
    await run(pe2, [
      'ip vrf RED', 'rd 65000:1', 'route-target export 65000:1', 'route-target import 65000:1', 'exit',
      'interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
      'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip vrf forwarding RED', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'exit',
      'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2',
    ]);
    for (const [router, iface] of [[pe1, 'GigabitEthernet0/1'], [p, 'GigabitEthernet0/0'], [p, 'GigabitEthernet0/1'], [pe2, 'GigabitEthernet0/0']] as const) {
      router.getLdpEngine().enableInterface(iface);
    }
    clock.advance(6000);
    for (const [router, peer] of [[pe1, '3.3.3.3'], [pe2, '1.1.1.1']] as const) {
      await run(router, ['router bgp 65000']);
      router.getBGPEngine().getConfig().neighbors.set(peer, { ip: peer, remoteAs: 65000, activated: true, updateSource: 'Loopback0', vpnv4: true });
      router.setVrfBgpRedistribution('RED', ['connected']);
      router.convergeDynamicRouting();
    }
    for (let round = 0; round < 2; round++) {
      pe1.convergeDynamicRouting(); pe2.convergeDynamicRouting(); clock.advance(10000);
    }
    return { pe1, p, pe2 };
  }

  const vpnFec = (prefix: string) => ({ kind: 'vpn-ipv4' as const, routeDistinguisher: '65000:1', prefix: new IPAddress(prefix), length: 24 });

  it('PE1 sends <transport, VPN> with the inner TTL at 1 and PE2 answers code 3 after popping the VPN label', async () => {
    const { pe1, p } = await vpnLab();
    const before = p.getMplsEngine().counters.labelledIn;
    const outcome = pe1.getMplsOam().ping([vpnFec('192.168.2.0')]);
    if (outcome.kind !== 'reply') throw new Error(`no reply: ${JSON.stringify(outcome)}`);
    expect(outcome.reply.message).toMatchObject({ returnCode: ReturnCode.Egress, returnSubcode: 1 });
    expect(String(outcome.reply.from)).toBe('3.3.3.3');
    expect(p.getMplsEngine().counters.labelledIn - before).toBe(1);
  });

  it('a VPN prefix the egress does not advertise is not sent', async () => {
    const { pe1 } = await vpnLab();
    expect(pe1.getMplsOam().ping([vpnFec('172.16.0.0')])).toEqual({ kind: 'not-sent', reason: 'no-vpn-route' });
  });
});
