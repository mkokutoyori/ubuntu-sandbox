/**
 * Probe: the IOS commands on top of the MPLS/LDP engines, and their
 * coherence with show running-config (CLAUDE.md rule 3).
 * Column layouts and line shapes come from the Cisco IOS-XE sample lines in
 * the genie.libs.parser show_mpls.py comments (header of
 * `show mpls forwarding-table`, `show mpls interfaces`, `show mpls ldp
 * neighbor|bindings|discovery`); not from a full captured transcript, which
 * TODO.md records.
 * Before the fix every case fails: the commands are refused.
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

async function pair() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  await run(r1, ['enable', 'configure terminal',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'mpls ip', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'end']);
  await run(r2, ['enable', 'configure terminal',
    'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'mpls ip', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'end']);
  clock.advance(6000);
  return { r1, r2 };
}

describe('mpls ip and the views', () => {
  it('`mpls label protocol tdp` is not offered: only the implemented protocol is declared', async () => {
    const r1 = new CiscoRouter('R1');
    const [, , tdp] = await run(r1, ['enable', 'configure terminal', 'mpls label protocol tdp']);
    expect(tdp).toContain('Invalid input');
  });

  it('show mpls interfaces lists the labelled interface with the IOS header', async () => {
    const { r1 } = await pair();
    const out = await r1.executeCommand('show mpls interfaces');
    expect(out.split('\n')[0]).toBe('Interface              IP            Tunnel   BGP Static Operational');
    expect(out.split('\n')[1]).toBe('GigabitEthernet0/1     Yes (ldp)     No       No  No     Yes');
  });

  it('show mpls ldp neighbor shows the operational session, its TCP ports and the peer addresses', async () => {
    const { r1 } = await pair();
    const out = await r1.executeCommand('show mpls ldp neighbor');
    expect(out).toContain('    Peer LDP Ident: 2.2.2.2:0; Local LDP Ident 1.1.1.1:0');
    expect(out).toMatch(/TCP connection: 2\.2\.2\.2\.\d+ - 1\.1\.1\.1\.\d+/);
    expect(out).toMatch(/State: Oper; Msgs sent\/rcvd: \d+\/\d+; Downstream/);
    expect(out).toContain('GigabitEthernet0/1, Src IP addr: 10.12.0.2');
    expect(out).toContain('holdtime: 15000 ms, hello interval: 5000 ms');
    expect(out).toMatch(/2\.2\.2\.2\s+10\.12\.0\.2/);
  });

  it('show mpls ldp bindings: local and remote bindings, imp-null for a connected prefix', async () => {
    const { r1 } = await pair();
    const out = await r1.executeCommand('show mpls ldp bindings');
    expect(out).toMatch(/lib entry: 1\.1\.1\.1\/32, rev \d+\n\s+local binding:  label: imp-null/);
    expect(out).toMatch(/lib entry: 2\.2\.2\.2\/32, rev \d+\n\s+local binding:  label: \d+\n\s+remote binding: lsr: 2\.2\.2\.2:0, label: imp-null/);
  });

  it('show mpls forwarding-table: Pop Label towards a neighbour that advertised imp-null, short interface name', async () => {
    const { r1 } = await pair();
    const lines = (await r1.executeCommand('show mpls forwarding-table')).split('\n');
    expect(lines[0]).toBe('Local      Outgoing   Prefix           Bytes Label   Outgoing   Next Hop');
    expect(lines[1]).toBe('Label      Label      or Tunnel Id     Switched      interface');
    expect(lines[2]).toMatch(/^\d+ +Pop Label +2\.2\.2\.2\/32 +0 +Gi0\/1 +10\.12\.0\.2$/);
  });

  it('show mpls ldp discovery names the local identifier and the discovered peer', async () => {
    const { r1 } = await pair();
    const out = await r1.executeCommand('show mpls ldp discovery');
    expect(out).toContain(' Local LDP Identifier:\n    1.1.1.1:0');
    expect(out).toContain('GigabitEthernet0/1 (ldp): xmit/recv');
    expect(out).toContain('LDP Id: 2.2.2.2:0');
  });
});

describe('global `no mpls ip`', () => {
  it('silences LDP on every interface and is written back; re-enabling re-forms the session after the 15 s throttle of a NAK (RFC 5036 §2.5.3)', async () => {
    const { r1, r2 } = await pair();
    await run(r1, ['configure terminal', 'no mpls ip', 'end']);
    expect(r1.getLdpEngine().sessions()).toHaveLength(0);
    expect(await r1.executeCommand('show running-config')).toContain('no mpls ip');
    clock.advance(20000);
    expect(r2.getLdpEngine().adjacencies()).toHaveLength(0);
    await run(r1, ['configure terminal', 'mpls ip', 'end']);
    clock.advance(10000);
    expect(r1.getLdpEngine().sessions()).toHaveLength(0);
    clock.advance(50000);
    expect(r1.getLdpEngine().sessions()).toHaveLength(1);
  });
});

describe('configuration is evaluated and written back (rule 3, rule 6)', () => {
  it('running-config shows `mpls ip` under the interface and the settings that were changed', async () => {
    const { r1 } = await pair();
    await run(r1, ['configure terminal', 'mpls ldp router-id Loopback0 force', 'no mpls ip propagate-ttl',
      'mpls ldp discovery hello holdtime 30', 'mpls ldp discovery hello interval 10', 'end']);
    const config = await r1.executeCommand('show running-config');
    expect(config).toContain('mpls ldp router-id Loopback0 force');
    expect(config).toContain('no mpls ip propagate-ttl');
    expect(config).toContain('mpls ldp discovery hello holdtime 30');
    expect(config).toContain('mpls ldp discovery hello interval 10');
    expect(config).toMatch(/interface GigabitEthernet0\/1\n[^!]*\n mpls ip/);
  });

  it('no mpls ip removes the line and tears the adjacency down', async () => {
    const { r1 } = await pair();
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/1', 'no mpls ip', 'end']);
    const config = await r1.executeCommand('show running-config');
    expect(config).not.toContain(' mpls ip');
    expect(r1.getLdpEngine().adjacencies()).toHaveLength(0);
  });

  it('the hello timers really change the cadence: an adjacency expires after the configured hold time', async () => {
    const { r1, r2 } = await pair();
    await run(r2, ['configure terminal', 'mpls ldp discovery hello holdtime 45', 'end']);
    await run(r1, ['configure terminal', 'mpls ldp discovery hello holdtime 45', 'end']);
    await run(r1, ['configure terminal', 'interface GigabitEthernet0/1', 'no mpls ip', 'end']);
    clock.advance(20000);
    expect(r2.getLdpEngine().adjacencies()).toHaveLength(1);
    clock.advance(40000);
    expect(r2.getLdpEngine().adjacencies()).toHaveLength(0);
  });

  it('no mpls ip propagate-ttl makes labels start at 255', async () => {
    const { r1 } = await pair();
    await run(r1, ['configure terminal', 'no mpls ip propagate-ttl', 'end']);
    expect(r1.getMplsEngine().propagateTtl).toBe(false);
  });

  it('a running-config without MPLS carries no MPLS line and creates no engine', async () => {
    const plain = new CiscoRouter('R9');
    const config = await plain.executeCommand('show running-config');
    expect(config).not.toContain('mpls');
    expect(plain.hasMplsEngines()).toBe(false);
  });
});
