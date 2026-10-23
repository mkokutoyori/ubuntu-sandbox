/**
 * Probe: LDP/MPLS show commands against the Cisco IOS Multiprotocol Label Switching
 * Command Reference (official_docs/cisco/mp-cr-book.pdf, the show mpls ldp neighbor,
 * discovery, bindings, parameters, capabilities, backoff, label range, forwarding-table
 * and interfaces pages). The PDF text has no indentation, so the line shapes keep the
 * layout already sourced from captured transcripts; this probe pins the CONTENT and
 * the arguments the book declares.
 * Before the change: 19 of 21 cases fail (the commands, arguments and fields did not
 * exist). Passing either way: the plain `show mpls ldp neighbor` and `show mpls
 * interfaces` cases, kept as non-regression.
 * Not covered, recorded in TODO.md [cli-mpls]: vrf/all variants, `labels N - N` ranges,
 * password and graceful-restart lines, and the Targeted Hellos line which the book
 * sample loses in extraction (the shape follows the field table).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await router.executeCommand(line));
  return out;
}

async function trio() {
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map(name => new CiscoRouter(name));
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  await run(r1, ['enable', 'configure terminal', 'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'mpls ip', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'end']);
  await run(r2, ['enable', 'configure terminal', 'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'mpls ip', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'mpls ip', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3', 'end']);
  await run(r3, ['enable', 'configure terminal', 'interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'mpls ip', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2', 'end']);
  clock.advance(8000);
  return { r1, r2, r3 };
}

describe('show mpls ldp neighbor', () => {
  it('plain form lists the session as before (non-regression)', async () => {
    const { r2 } = await trio();
    const out = await r2.executeCommand('show mpls ldp neighbor');
    expect(out).toContain('Peer LDP Ident: 1.1.1.1:0; Local LDP Ident 2.2.2.2:0');
    expect(out).toContain('Peer LDP Ident: 3.3.3.3:0; Local LDP Ident 2.2.2.2:0');
  });

  it('an address argument selects the neighbor, by LDP id or by a bound address', async () => {
    const { r2 } = await trio();
    const byId = await r2.executeCommand('show mpls ldp neighbor 1.1.1.1');
    expect(byId).toContain('Peer LDP Ident: 1.1.1.1:0');
    expect(byId).not.toContain('3.3.3.3:0');
    const byBound = await r2.executeCommand('show mpls ldp neighbor 10.23.0.3');
    expect(byBound).toContain('Peer LDP Ident: 3.3.3.3:0');
    expect(byBound).not.toContain('1.1.1.1:0;');
  });

  it('an interface argument selects the neighbors discovered on it', async () => {
    const { r2 } = await trio();
    const out = await r2.executeCommand('show mpls ldp neighbor GigabitEthernet0/1');
    expect(out).toContain('Peer LDP Ident: 3.3.3.3:0');
    expect(out).not.toContain('Peer LDP Ident: 1.1.1.1:0');
  });

  it('detail adds the last revision sent, the UID and peer id, the peer hold time and the keepalive interval', async () => {
    const { r2 } = await trio();
    const out = await r2.executeCommand('show mpls ldp neighbor detail');
    expect(out).toMatch(/State: Oper; Msgs sent\/rcvd: \d+\/\d+; Downstream; Last TIB rev sent \d+/);
    expect(out).toMatch(/Up time: \d\d:\d\d:\d\d; UID: \d+; Peer Id \d+;/);
    expect(out).toContain('Peer holdtime: 180000 ms; KA interval: 60000 ms; Peer state: estab');
  });

  it('a targeted session is listed with its discovery source in the book form', async () => {
    const { r1, r3 } = await trio();
    await run(r1, ['configure terminal', 'mpls ldp neighbor 3.3.3.3 targeted ldp', 'end']);
    await run(r3, ['configure terminal', 'mpls ldp discovery targeted-hello accept', 'end']);
    await run(r1, ['configure terminal', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2', 'end']);
    clock.advance(60000);
    const out = await r1.executeCommand('show mpls ldp neighbor 3.3.3.3 detail');
    expect(out).toContain('Targeted Hello 1.1.1.1 -> 3.3.3.3, active;');
  });
});

describe('show mpls ldp discovery', () => {
  it('lists the interface and the discovered LDP ids, and detail adds the hello interval, source, transport and hold times', async () => {
    const { r2 } = await trio();
    const plain = await r2.executeCommand('show mpls ldp discovery');
    expect(plain).toContain('GigabitEthernet0/0 (ldp): xmit/recv');
    expect(plain).toContain('LDP Id: 1.1.1.1:0');
    const detail = await r2.executeCommand('show mpls ldp discovery detail');
    expect(detail).toContain('Hello interval: 5000 ms; Transport IP addr: 2.2.2.2');
    expect(detail).toContain('Src IP addr: 10.12.0.1; Transport IP addr: 1.1.1.1');
    expect(detail).toContain('Hold time: 15 sec; Proposed local/peer: 15/15 sec');
  });

  it('a configured targeted neighbor appears under Targeted Hellos', async () => {
    const { r1 } = await trio();
    await run(r1, ['configure terminal', 'mpls ldp neighbor 3.3.3.3 targeted ldp', 'end']);
    expect(await r1.executeCommand('show mpls ldp discovery')).toContain('Targeted Hellos:\n        1.1.1.1 -> 3.3.3.3 (ldp): active, xmit');
  });
});

describe('show mpls ldp bindings', () => {
  it('network and length select one entry; longer-prefixes selects the more specific ones', async () => {
    const { r1 } = await trio();
    const one = await r1.executeCommand('show mpls ldp bindings 3.3.3.3 32');
    expect(one).toContain('lib entry: 3.3.3.3/32');
    expect(one).not.toContain('lib entry: 2.2.2.2/32');
    const several = await r1.executeCommand('show mpls ldp bindings 2.0.0.0 7 longer-prefixes');
    expect(several).toContain('lib entry: 2.2.2.2/32');
    expect(several).toContain('lib entry: 3.3.3.3/32');
    expect(several).not.toContain('lib entry: 1.1.1.1/32');
  });

  it('local-label selects by label value; the dotted mask form is accepted', async () => {
    const { r1 } = await trio();
    const table = await r1.executeCommand('show mpls ldp bindings');
    const label = /lib entry: 3\.3\.3\.3\/32, rev \d+\n\s+local binding:\s+label: (\d+)/.exec(table)![1];
    const out = await r1.executeCommand(`show mpls ldp bindings local-label ${label}`);
    expect(out).toContain('lib entry: 3.3.3.3/32');
    expect(out.match(/lib entry/g)).toHaveLength(1);
    expect(await r1.executeCommand('show mpls ldp bindings 3.3.3.3 255.255.255.255')).toContain('lib entry: 3.3.3.3/32');
  });

  it('neighbor shows only that peer\'s remote bindings and suppresses the local ones', async () => {
    const { r2 } = await trio();
    const out = await r2.executeCommand('show mpls ldp bindings neighbor 3.3.3.3');
    expect(out).toContain('remote binding: lsr: 3.3.3.3:0');
    expect(out).not.toContain('local binding');
    expect(out).not.toContain('lsr: 1.1.1.1:0');
  });

  it('local shows the local bindings only, and detail lists to whom each was advertised', async () => {
    const { r2 } = await trio();
    const local = await r2.executeCommand('show mpls ldp bindings local');
    expect(local).toContain('local binding');
    expect(local).not.toContain('remote binding');
    const detail = await r2.executeCommand('show mpls ldp bindings 3.3.3.3 32 detail');
    expect(detail).toContain('Advertised to:');
    expect(detail).toContain('1.1.1.1:0');
  });
});

describe('parameters, capabilities, backoff and label range', () => {
  it('show mpls ldp parameters prints the book fields from the live configuration', async () => {
    const { r1 } = await trio();
    expect(await r1.executeCommand('show mpls ldp parameters')).toBe([
      'Protocol version: 1',
      'Downstream label pool: min label 16; max label 100000',
      'Session hold time: 180 sec; keep alive interval: 60 sec',
      'Discovery hello: holdtime: 15 sec; interval: 5 sec',
      'Discovery targeted hello: holdtime: 45 sec; interval: 15 sec',
      'LDP initial/maximum backoff: 15/120 sec',
    ].join('\n'));
  });

  it('the parameters follow the configuration (hello timers)', async () => {
    const { r1 } = await trio();
    await run(r1, ['configure terminal', 'mpls ldp discovery hello holdtime 30', 'mpls ldp discovery hello interval 10', 'end']);
    const out = await r1.executeCommand('show mpls ldp parameters');
    expect(out).toContain('Discovery hello: holdtime: 30 sec; interval: 10 sec');
  });

  it('show mpls ldp capabilities lists none: this LSR advertises no capability TLV', async () => {
    const { r1 } = await trio();
    expect(await r1.executeCommand('show mpls ldp capabilities')).toBe(
      'LDP Capabilities - [<description> (<type>)]\n---------------------------------------------------------');
  });

  it('show mpls ldp backoff prints the parameters and an empty table', async () => {
    const { r1 } = await trio();
    const out = await r1.executeCommand('show mpls ldp backoff');
    expect(out).toContain('LDP initial/maximum backoff: 15/120 sec');
    expect(out).toContain('Backoff table: 0 entries');
  });

  it('show mpls label range prints the downstream pool', async () => {
    const { r1 } = await trio();
    expect(await r1.executeCommand('show mpls label range')).toBe('Downstream label pool: Min/Max label: 16/100000');
  });
});

describe('show mpls forwarding-table', () => {
  it('network and mask select one entry', async () => {
    const { r1 } = await trio();
    const out = await r1.executeCommand('show mpls forwarding-table 3.3.3.3 32');
    expect(out).toContain('3.3.3.3/32');
    expect(out).not.toContain('2.2.2.2/32');
  });

  it('interface, labels and next-hop filters apply', async () => {
    const { r2 } = await trio();
    const all = await r2.executeCommand('show mpls forwarding-table');
    expect(all).toContain('Gi0/1');
    const byInterface = await r2.executeCommand('show mpls forwarding-table interface GigabitEthernet0/1');
    expect(byInterface).toContain('3.3.3.3/32');
    expect(byInterface).not.toContain('1.1.1.1/32');
    const byHop = await r2.executeCommand('show mpls forwarding-table next-hop 10.12.0.1');
    expect(byHop).toContain('1.1.1.1/32');
    expect(byHop).not.toContain('3.3.3.3/32');
    const byLabel = await r2.executeCommand('show mpls forwarding-table labels 1');
    expect(byLabel.split('\n')).toHaveLength(2);
  });

  it('detail adds the MAC/Encaps line, the MTU, the label stack and the feature line', async () => {
    const { r1 } = await trio();
    const out = await r1.executeCommand('show mpls forwarding-table 3.3.3.3 32 detail');
    expect(out).toMatch(/MAC\/Encaps=14\/18, MTU=1500, Label Stack\{\d+\}/);
    expect(out).toMatch(/[0-9A-F]{24}8847 [0-9A-F]{8}/);
    expect(out).toContain('No output feature configured');
  });
});

describe('show mpls interfaces', () => {
  it('plain form keeps the table (non-regression)', async () => {
    const { r1 } = await trio();
    expect((await r1.executeCommand('show mpls interfaces')).split('\n')[1]).toContain('GigabitEthernet0/0');
  });

  it('detail prints the per-interface block of the book, and an interface argument selects one', async () => {
    const { r2 } = await trio();
    const out = await r2.executeCommand('show mpls interfaces GigabitEthernet0/1 detail');
    expect(out).toBe([
      'Interface GigabitEthernet0/1:', '        IP labeling enabled (ldp)', '        LSP Tunnel labeling not enabled',
      '        MPLS operational', '        MTU = 1500',
    ].join('\n'));
  });
});
