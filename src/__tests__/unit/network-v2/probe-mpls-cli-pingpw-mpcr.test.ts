/**
 * Probe: ping mpls pseudowire of the Cisco IOS Multiprotocol Label Switching Command Reference
 * (official_docs/cisco/mp-cr-book.pdf, ping mpls), carried by the FEC 128 Pseudowire IPv4 of
 * RFC 8029 section 3.2.9 and validated at the egress by section 4.4.1: the echo request crosses
 * the core with the transport label and the pseudowire label (TTL 1), the egress PE checks the
 * PW ID, the PW type and the sender against its own pseudowire and the label it advertised.
 * Lab: CE1 - PE1 - P - PE2 - CE2, VC 100 between the PEs.
 * Before the change 8 of the 9 cases fail (the keyword, the FEC and its validation did not exist).
 * The one that passes either way is the refusal of the segment keyword: nothing evaluates a
 * multisegment pseudowire (TODO.md [cli-mpls-oam]). The unknown VC and the peer without
 * pseudowire are the witnesses of the sender: they answer Q because the lab, not the command,
 * has no such pseudowire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateEchoRequest } from '@/network/mpls/oam/EchoResponder';
import { encodeEcho, decodeEcho, newEchoMessage, EchoMessageType, ReturnCode } from '@/network/mpls/oam/EchoCodec';
import { IPAddress } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) out.push(await router.executeCommand(line));
  return out.slice(2, -1);
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

async function lab() {
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
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2']);
  await run(p, ['interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(pe2, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'mpls ip', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2']);
  await ce1.executeCommand('sudo ip addr add 192.168.0.1/24 dev eth0');
  await ce2.executeCommand('sudo ip addr add 192.168.0.2/24 dev eth0');
  clock.advance(6000);
  return { ce1, ce2, pe1, pe2 };
}

async function pseudowire(options: { classControlWord?: boolean } = {}) {
  const { ce1, ce2, pe1, pe2 } = await lab();
  await run(pe1, ['pseudowire-class PW1', 'encapsulation mpls', ...(options.classControlWord ? ['control-word'] : []), 'exit',
    'interface GigabitEthernet0/0', 'xconnect 3.3.3.3 100 pw-class PW1']);
  await run(pe2, ['pseudowire-class PW1', 'encapsulation mpls', ...(options.classControlWord ? ['control-word'] : []), 'exit',
    'interface GigabitEthernet0/1', 'xconnect 1.1.1.1 100 pw-class PW1']);
  clock.advance(90000);
  return { ce1, ce2, pe1, pe2 };
}


const VC = 100;

async function ping(router: CiscoRouter, text: string): Promise<string> {
  await router.executeCommand('enable');
  return router.executeCommand(text);
}

describe('ping mpls pseudowire', () => {
  it('reaches the egress PE through the core: five exclamation marks and a full success rate', async () => {
    const { pe1 } = await pseudowire();
    const out = await ping(pe1, `ping mpls pseudowire 3.3.3.3 ${VC}`);
    expect(out).toContain('Sending 5, 100-byte MPLS Echos to 3.3.3.3, timeout is 2 seconds:');
    expect(out).toContain('\n!!!!!\n');
    expect(out).toContain('Success rate is 100 percent (5/5)');
  });

  it('verbose names the egress PE and the return code 3', async () => {
    const { pe1 } = await pseudowire();
    const out = await ping(pe1, `ping mpls pseudowire 3.3.3.3 ${VC} repeat 2 verbose`);
    expect(out.match(/! 3\.3\.3\.3, return code 3/g)).toHaveLength(2);
  });

  it('the request is trapped at the egress PE and labelled-switched by the P router', async () => {
    const { pe1, pe2 } = await pseudowire();
    const trapped = pe2.getMplsEngine().counters.echoRequests;
    await ping(pe1, `ping mpls pseudowire 3.3.3.3 ${VC} repeat 3`);
    expect(pe2.getMplsEngine().counters.echoRequests - trapped).toBe(3);
  });

  it('size above the interface MTU is not sent', async () => {
    const { pe1 } = await pseudowire();
    expect(await ping(pe1, `ping mpls pseudowire 3.3.3.3 ${VC} repeat 2 size 1600`)).toContain('QQ');
  });

  it('WITNESS: an unknown VC id is not sent', async () => {
    const { pe1 } = await pseudowire();
    const out = await ping(pe1, `ping mpls pseudowire 3.3.3.3 999 repeat 2`);
    expect(out).toContain('\nQQ\n');
    expect(out).toContain('Success rate is 0 percent (0/2)');
  });

  it('WITNESS: a peer with no pseudowire is not sent', async () => {
    const { pe1 } = await pseudowire();
    expect(await ping(pe1, `ping mpls pseudowire 2.2.2.2 ${VC} repeat 1`)).toContain('\nQ\n');
  });

  it('the segment keyword of multisegment pseudowires is refused', async () => {
    const { pe1 } = await pseudowire();
    expect(await ping(pe1, `ping mpls pseudowire 3.3.3.3 ${VC} segment 2`)).toContain('% Invalid input');
  });

  it('the egress answers 4 (no mapping) for a PW ID it does not hold and 10 for a label that is not its own', async () => {
    const { pe2 } = await pseudowire();
    const view = pe2.getPseudowireEngine().views()[0];
    const oam = pe2.getMplsOam();
    const request = (pwId: number) => newEchoMessage({
      messageType: EchoMessageType.Request, senderHandle: 1, sequenceNumber: 1,
      targetFecs: [{ kind: 'pw-ipv4', sender: new IPAddress('1.1.1.1'), remote: new IPAddress('3.3.3.3'), pwId, pwType: view.pwType }],
    });
    const receipt = (label: number) => ({ interfaceName: 'GigabitEthernet0/0', routerAddress: new IPAddress('3.3.3.3'), interfaceAddress: new IPAddress('10.23.0.3'), labels: [label], topTtl: 1 });
    const own = view.localLabel!.value;
    const good = evaluateEchoRequest(request(VC), receipt(own), oam);
    const unknown = evaluateEchoRequest(request(VC + 1), receipt(own), oam);
    const wrongLabel = evaluateEchoRequest(request(VC), receipt(own + 1), oam);
    expect([good, unknown, wrongLabel].map(verdict => (verdict.reply ? verdict.returnCode : -1)))
      .toEqual([ReturnCode.Egress, ReturnCode.NoMapping, ReturnCode.NoLabelEntry]);
  });

  it('the FEC 128 survives the wire: 16 octets with PW type right-justified', () => {
    const fec = { kind: 'pw-ipv4' as const, sender: new IPAddress('1.1.1.1'), remote: new IPAddress('3.3.3.3'), pwId: 4660, pwType: 5 };
    const decoded = decodeEcho(encodeEcho(newEchoMessage({ messageType: EchoMessageType.Request, senderHandle: 1, sequenceNumber: 1, targetFecs: [fec] })));
    expect(decoded.targetFecs[0]).toMatchObject({ kind: 'pw-ipv4', pwId: 4660, pwType: 5 });
  });
});
