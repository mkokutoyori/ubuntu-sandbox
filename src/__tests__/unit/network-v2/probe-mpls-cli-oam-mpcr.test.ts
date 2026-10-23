/**
 * Probe: `ping mpls ipv4` and `traceroute mpls ipv4` against the Cisco IOS Multiprotocol
 * Label Switching Command Reference (official_docs/cisco/mp-cr-book.pdf: ping mpls,
 * traceroute mpls). The output is the book's: the Sending line, the Codes block, one
 * character per echo (or `<char> <replier>, return code N` with verbose), the success
 * summary with round-trip times; the trace prints `0 <local interface> mtu M [labels]`
 * then one line per hop with the downstream mapping the transit router returned.
 * A chain of four LDP routers, FEC 9.9.9.0/24 owned by the last one (as in
 * probe-mpls-oam-ddmap-rfc8029).
 * Before the change: 13 of 15 cases fail (`ping mpls` is refused). The two that pass either way
 * are the WITNESS cases at the end: the forms the engine cannot serve (pseudowire, traffic-eng, a bad
 * mask, source/interval/sweep) stay refused.
 * Not declared, because nothing evaluates them (TODO.md [cli-mpls-oam]): source,
 * interval, sweep, pad pattern, force-explicit-null, output, revision, flags fec,
 * hashkey, destination ranges, pseudowire, traffic-eng, tp and multipath. Only one `reply`
 * clause is taken per command (the option bag offers a keyword once).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsEchoAgent } from '@/network/mpls/oam/EchoAgent';
import { PadInstruction, ReplyMode, decodeEcho } from '@/network/mpls/oam/EchoCodec';
import { Router } from '@/network/devices/Router';
import { ldpChain, lsr } from './_ldp-chain-lab';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });
afterEach(() => vi.restoreAllMocks());

async function lab() {
  const routers = await ldpChain(clock, { length: 4, fullRouting: true });
  await routers[0].executeCommand('enable');
  return routers;
}

const requests = () => {
  const built: ReturnType<typeof decodeEcho>[] = [];
  const original = MplsEchoAgent.prototype.buildRequest;
  vi.spyOn(MplsEchoAgent.prototype, 'buildRequest').mockImplementation(function (this: MplsEchoAgent, ...args) {
    const result = original.apply(this, args);
    const udp = result.packet.payload as { payload: Uint8Array };
    built.push(decodeEcho(udp.payload));
    return result;
  });
  return built;
};

describe('ping mpls ipv4', () => {
  it('prints the book layout: Sending line, Codes block, one ! per echo and the success line', async () => {
    const [first] = await lab();
    const out = await first.executeCommand('ping mpls ipv4 9.9.9.0/24');
    const lines = out.split('\n');
    expect(lines[0]).toBe('Sending 5, 100-byte MPLS Echos to 9.9.9.0, timeout is 2 seconds:');
    expect(lines[1]).toBe('Codes:');
    expect(lines).toContain("'R' - transit router, 'X' - unknown return code, 'x' - return code 0");
    expect(lines).toContain('Type escape sequence to abort.');
    expect(lines).toContain('!!!!!');
    expect(lines.at(-1)).toMatch(/^Success rate is 100 percent \(5\/5\), round-trip min\/avg\/max = \d+\/\d+\/\d+ ms$/);
  });

  it('repeat sets the number of echoes', async () => {
    const [first] = await lab();
    const out = await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 2');
    expect(out).toContain('Sending 2, 100-byte');
    expect(out).toContain('\n!!\n');
    expect(out).toContain('(2/2)');
  });

  it('verbose prints the replier and the return code of each echo', async () => {
    const [first] = await lab();
    const out = await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 2 verbose');
    expect(out.split('\n').filter(line => line.startsWith('!'))).toEqual([`! ${lsr(3)}, return code 3`, `! ${lsr(3)}, return code 3`]);
  });

  it('ttl 1 expires at the first transit router: R, return code 8, and it is not a success', async () => {
    const [first] = await lab();
    const out = await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 2 ttl 1 verbose');
    expect(out).toContain(`R ${lsr(1)}, return code 8`);
    expect(out).toContain('Success rate is 0 percent (0/2)');
  });

  it('a FEC with no label binding is not sent: Q, 0 percent', async () => {
    const [first] = await lab();
    const out = await first.executeCommand('ping mpls ipv4 8.8.8.0/24');
    expect(out).toContain('\nQQQQQ\n');
    expect(out.split('\n').at(-1)).toBe('Success rate is 0 percent (0/5)');
  });

  it('size larger than the output interface MTU is not sent (Q), size within it is, and the request is padded to it', async () => {
    const [first] = await lab();
    const built = requests();
    expect(await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 2 size 1600')).toContain('\nQQ\n');
    const ok = await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1 size 1400');
    expect(ok).toContain('Sending 1, 1400-byte');
    expect(ok).toContain('\n!\n');
    const padded = built.at(-1)!;
    expect(padded.pad).not.toBeNull();
    expect(padded.pad!.length).toBeGreaterThan(1300);
  });

  it('reply mode, reply dscp and reply pad-tlv (one reply clause per command) shape the request that goes on the wire', async () => {
    const [first] = await lab();
    const built = requests();
    await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1 reply mode router-alert');
    expect(built.at(-1)!.replyMode).toBe(ReplyMode.UdpRouterAlert);
    await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1 reply dscp 46');
    expect(built.at(-1)!.replyTosByte).toBe(46 << 2);
    await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1 reply pad-tlv');
    expect(built.at(-1)!.pad?.instruction).toBe(PadInstruction.CopyToReply);
  });

  it('dsmap with ttl interrogates a transit router: the request carries a Downstream Detailed Mapping', async () => {
    const [first] = await lab();
    const built = requests();
    await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1 ttl 1 dsmap');
    expect(built.at(-1)!.ddmaps).toHaveLength(1);
  });

  it('exp sets the traffic class of the label stack entries', async () => {
    const [first] = await lab();
    const spy = vi.spyOn(Router.prototype as unknown as { sendMplsFrameArpAware: (...a: unknown[]) => unknown }, 'sendMplsFrameArpAware');
    await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1 exp 5');
    const packet = spy.mock.calls.map(call => call[1] as { stack: { trafficClass: number }[] }).find(p => p.stack !== undefined);
    expect(packet!.stack[0].trafficClass).toBe(5);
  });

  it('without a DDMAP request a plain ping reaches the egress with no mapping (non-regression of the engine)', async () => {
    const [first] = await lab();
    const built = requests();
    await first.executeCommand('ping mpls ipv4 9.9.9.0/24 repeat 1');
    expect(built.at(-1)!.ddmaps).toHaveLength(0);
  });
});

describe('traceroute mpls ipv4', () => {
  it('prints hop 0, the transit hops with the downstream mtu and labels, and the egress', async () => {
    const [first, second] = await lab();
    const out = await first.executeCommand('traceroute mpls ipv4 9.9.9.0/24');
    const lines = out.split('\n');
    expect(lines[0]).toBe('Tracing MPLS Label Switched Path to 9.9.9.0/24, timeout is 2 seconds');
    expect(lines).toContain('Type escape sequence to abort.');
    const start = lines.findIndex(line => line.startsWith('  0 '));
    const label = second.getLdpEngine().bindings().find(b => String(b.fec.prefix) === '9.9.9.0')!.label.value;
    expect(lines[start]).toMatch(/^ {2}0 10\.0\.0\.1 mtu 1500 \[Labels: \d+ Exp: 0\]$/);
    expect(lines[start]).toContain(`[Labels: ${label} Exp: 0]`);
    expect(lines[start + 1]).toMatch(new RegExp(`^R 1 ${lsr(1).replace(/\./g, '\\.')} mtu 1500 \\[Labels: \\d+ Exp: 0\\] \\d+ ms$`));
    expect(lines[start + 2]).toMatch(new RegExp(`^R 2 ${lsr(2).replace(/\./g, '\\.')} mtu 1500 \\[implicit-null\\] \\d+ ms$`));
    expect(lines[start + 3]).toMatch(new RegExp(`^! 3 ${lsr(3).replace(/\./g, '\\.')} \\d+ ms$`));
  });

  it('ttl bounds the trace', async () => {
    const [first] = await lab();
    const out = await first.executeCommand('traceroute mpls ipv4 9.9.9.0/24 ttl 2');
    expect(out).toContain('R 2 ');
    expect(out).not.toContain('! 3');
  });

  it('a FEC with no label binding is not sent', async () => {
    const [first] = await lab();
    expect(await first.executeCommand('traceroute mpls ipv4 8.8.8.0/24')).toContain('\nQ 1');
  });
});

describe('forms the engine cannot serve stay refused', () => {
  it('WITNESS: pseudowire, traffic-eng and a malformed mask are not accepted', async () => {
    const [first] = await lab();
    expect(await first.executeCommand('ping mpls pseudowire 104.104.104.104 100')).toContain('Invalid input');
    expect(await first.executeCommand('ping mpls traffic-eng Tunnel 0')).toContain('Invalid input');
    expect(await first.executeCommand('ping mpls ipv4 9.9.9.0/33')).toContain('Invalid input');
  });

  it('WITNESS: the options nothing evaluates are not accepted (source, interval, sweep)', async () => {
    const [first] = await lab();
    for (const option of ['source 1.1.1.1', 'interval 100', 'sweep 100 200 10']) {
      expect(await first.executeCommand(`ping mpls ipv4 9.9.9.0/24 ${option}`)).toContain('Invalid input');
    }
  });
});
