/**
 * Probe: the L2VPN commands of the Cisco IOS Multiprotocol Label Switching Command
 * Reference (official_docs/cisco/mp-cr-book.pdf: pseudowire-class, xconnect, l2 vfi manual,
 * vpn id, neighbor, show mpls l2transport vc, show xconnect, show vfi), each checked for
 * its EFFECT on the pseudowire / VPLS engines, in show running-config and in its `no` form.
 * Lab: CE1 - PE1 - P - PE2 - CE2, LDP on the core, the customer subnet 192.168.0.0/24.
 * Before the change: 14 of 17 cases fail (pseudowire-class, xconnect pw-class, l2 vfi, the show
 * commands and the statistics did not exist). The 3 that pass either way are refusals and the
 * lab witness: the CEs are not connected before any configuration, a missing pseudowire class is
 * refused, and the forms nothing evaluates stay refused.
 * Refused because nothing evaluates them (TODO.md [cli-mpls-l2vpn]): neighbor ... no-split-horizon,
 * l2tpv3, manual static pseudowires, preferred-path, sequencing and the autodiscovery VFI.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

describe('pseudowire-class and xconnect', () => {
  it('WITNESS: before any configuration the CEs are not connected', async () => {
    const { ce1 } = await lab();
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('0 received');
  });

  it('xconnect with a pseudowire class brings the pseudowire up and carries the CEs traffic', async () => {
    const { ce1, pe1 } = await pseudowire();
    expect(pe1.getPseudowireEngine().views()[0]).toMatchObject({ state: 'up', pwClass: 'PW1' });
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
  });

  it('control-word in the class turns the control word on, and toggling it re-signals the live pseudowire', async () => {
    const { ce1, pe1, pe2 } = await pseudowire({ classControlWord: true });
    expect(pe1.getPseudowireEngine().views()[0].controlWord).toBe(true);
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
    await run(pe1, ['pseudowire-class PW1', 'no control-word']);
    await run(pe2, ['pseudowire-class PW1', 'no control-word']);
    clock.advance(90000);
    expect(pe1.getPseudowireEngine().views()[0]).toMatchObject({ controlWord: false, state: 'up' });
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
  });

  it('refuses a pseudowire class that does not exist', async () => {
    const { pe1 } = await lab();
    const out = await run(pe1, ['interface GigabitEthernet0/0', 'xconnect 3.3.3.3 100 pw-class MISSING']);
    expect(out[1]).toContain('Invalid input');
  });

  it('is in the running-config (class block and interface line), and the no forms remove it', async () => {
    const { pe1 } = await pseudowire({ classControlWord: true });
    const text = await pe1.executeCommand('show running-config');
    expect(text).toContain('pseudowire-class PW1\n encapsulation mpls\n control-word');
    expect(text).toContain(' xconnect 3.3.3.3 100 pw-class PW1');
    await run(pe1, ['interface GigabitEthernet0/0', 'no xconnect', 'exit', 'no pseudowire-class PW1']);
    const after = await pe1.executeCommand('show running-config');
    expect(after).not.toContain('pseudowire-class');
    expect(after).not.toContain('xconnect 3.3.3.3');
  });
});

describe('show mpls l2transport vc', () => {
  it('summary: the book header and one row per virtual circuit', async () => {
    const { pe1 } = await pseudowire();
    const out = (await pe1.executeCommand('show mpls l2transport vc')).split('\n');
    expect(out[0]).toBe('Local intf     Local circuit              Dest address    VC ID      Status');
    expect(out[2]).toMatch(/^Gi0\/0 +Ethernet +3\.3\.3\.3 +100 +UP$/);
  });

  it('detail: destination, status, labels, MTU, signalling peer and the output path', async () => {
    const { pe1, pe2 } = await pseudowire();
    const out = await pe1.executeCommand('show mpls l2transport vc detail');
    const local = pe1.getPseudowireEngine().views()[0].localLabel!.value;
    const remote = pe2.getPseudowireEngine().views()[0].localLabel!.value;
    expect(out).toContain('Local interface: Gi0/0 up, line protocol up, Ethernet up');
    expect(out).toContain('Destination address: 3.3.3.3, VC ID: 100, VC status: up');
    expect(out).toMatch(/Output interface: Gi0\/1, imposed label stack \{\d+ \d+\}/);
    expect(out).toContain('Signaling protocol: LDP, peer 3.3.3.3:0 up');
    expect(out).toContain(`MPLS VC labels: local ${local}, remote ${remote}`);
    expect(out).toContain('Group ID: local 0, remote 0');
    expect(out).toContain('MTU: local 1500, remote 1500');
    expect(out).toContain('Sequencing: receive disabled, send disabled');
    expect(out).toMatch(/Create time: \d\d:\d\d:\d\d, last status change time: \d\d:\d\d:\d\d/);
  });

  it('VC statistics count the frames and bytes that crossed the pseudowire in both directions', async () => {
    const { ce1, pe1 } = await pseudowire();
    await whileTimePasses(ce1.executeCommand('ping -c 3 -W 1 192.168.0.2'));
    const out = await pe1.executeCommand('show mpls l2transport vc detail');
    const sent = Number(/packet totals: receive \d+, send (\d+)/.exec(out)![1]);
    const received = Number(/packet totals: receive (\d+), send \d+/.exec(out)![1]);
    expect(sent).toBeGreaterThanOrEqual(3);
    expect(received).toBeGreaterThanOrEqual(3);
    expect(Number(/byte totals: +receive \d+, send (\d+)/.exec(out)![1])).toBeGreaterThan(0);
  });

  it('filters select by VC ID, VC ID range, destination and interface', async () => {
    const { pe1 } = await pseudowire();
    expect(await pe1.executeCommand('show mpls l2transport vc 100')).toContain('3.3.3.3');
    expect(await pe1.executeCommand('show mpls l2transport vc vcid 100')).toContain('3.3.3.3');
    expect(await pe1.executeCommand('show mpls l2transport vc 1 99')).not.toContain('3.3.3.3');
    expect(await pe1.executeCommand('show mpls l2transport vc destination 3.3.3.3')).toContain(' 100 ');
    expect(await pe1.executeCommand('show mpls l2transport vc destination 9.9.9.9')).not.toContain(' 100 ');
    expect(await pe1.executeCommand('show mpls l2transport vc interface GigabitEthernet0/0')).toContain(' 100 ');
    expect(await pe1.executeCommand('show mpls l2transport vc interface GigabitEthernet0/1')).not.toContain(' 100 ');
  });

  it('a pseudowire whose attachment circuit goes down is DOWN in the summary and in the detail', async () => {
    const { pe1 } = await pseudowire();
    await run(pe1, ['interface GigabitEthernet0/0', 'shutdown']);
    clock.advance(1000);
    expect(await pe1.executeCommand('show mpls l2transport vc')).toMatch(/ 100 +DOWN$/m);
    expect(await pe1.executeCommand('show mpls l2transport vc detail')).toContain('VC status: down');
  });
});

describe('show xconnect', () => {
  it('all: the legend, the columns and one row per pseudowire; detail adds the VC labels and the class', async () => {
    const { pe1, pe2 } = await pseudowire();
    const out = await pe1.executeCommand('show xconnect all');
    expect(out).toContain('XC ST  Segment 1                         S1 Segment 2                         S2');
    expect(out).toMatch(/^UP +ac +Gi0\/0\(Ethernet\) +UP +mpls 3\.3\.3\.3:100 +UP$/m);
    const detail = await pe1.executeCommand('show xconnect all detail');
    expect(detail).toContain(`Local VC label ${pe1.getPseudowireEngine().views()[0].localLabel!.value}`);
    expect(detail).toContain(`Remote VC label ${pe2.getPseudowireEngine().views()[0].localLabel!.value}`);
    expect(detail).toContain('pw-class: PW1');
  });

  it('peer and interface select the pseudowire', async () => {
    const { pe1 } = await pseudowire();
    expect(await pe1.executeCommand('show xconnect peer 3.3.3.3 vcid 100')).toContain('mpls 3.3.3.3:100');
    expect(await pe1.executeCommand('show xconnect peer 3.3.3.3 vcid 999')).not.toContain('mpls 3.3.3.3');
    expect(await pe1.executeCommand('show xconnect peer 3.3.3.3 all')).toContain('mpls 3.3.3.3:100');
    expect(await pe1.executeCommand('show xconnect interface GigabitEthernet0/0')).toContain('mpls 3.3.3.3:100');
    expect(await pe1.executeCommand('show xconnect interface GigabitEthernet0/1')).not.toContain('mpls 3.3.3.3');
  });
});

describe('VPLS from the CLI: l2 vfi manual', () => {
  async function vpls(options: { neighborFirst?: boolean } = {}) {
    const { ce1, ce2, pe1, pe2 } = await lab();
    const vfi = (peer: string) => options.neighborFirst
      ? ['l2 vfi CUST manual', `neighbor ${peer} encapsulation mpls`, 'vpn id 100', 'exit']
      : ['l2 vfi CUST manual', 'vpn id 100', `neighbor ${peer} encapsulation mpls`, 'exit'];
    await run(pe1, [...vfi('3.3.3.3'), 'interface GigabitEthernet0/0', 'xconnect vfi CUST']);
    await run(pe2, [...vfi('1.1.1.1'), 'interface GigabitEthernet0/1', 'xconnect vfi CUST']);
    clock.advance(90000);
    return { ce1, ce2, pe1, pe2 };
  }

  it('the VFI joins the two attachment circuits: the CEs reach each other', async () => {
    const { ce1, pe1 } = await vpls();
    expect(pe1.getVplsEngine().neighborViews('CUST').map(view => view.state)).toEqual(['up']);
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
  });

  it('the order of vpn id and neighbor does not matter', async () => {
    const { ce1 } = await vpls({ neighborFirst: true });
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.0.2'))).toContain('2 received');
  });

  it('show vfi and show vfi name print the VPN id, the attachment circuit and the neighbors', async () => {
    const { pe1 } = await vpls();
    const out = await pe1.executeCommand('show vfi name CUST');
    expect(out).toContain('VFI name: CUST, state: up');
    expect(out).toContain('VPN ID: 100');
    expect(out).toContain('Gi0/0');
    expect(out).toMatch(/3\.3\.3\.3 +100 +Y/);
    expect(await pe1.executeCommand('show vfi')).toContain('VFI name: CUST');
    expect(await pe1.executeCommand('show vfi name OTHER')).toBe('');
  });

  it('is in the running-config, and the no forms remove the VFI and stop the traffic', async () => {
    const { ce1, pe1 } = await vpls();
    const text = await pe1.executeCommand('show running-config');
    expect(text).toContain('l2 vfi CUST manual\n vpn id 100\n neighbor 3.3.3.3 encapsulation mpls');
    expect(text).toContain(' xconnect vfi CUST');
    await run(pe1, ['no l2 vfi CUST manual']);
    clock.advance(1000);
    const after = await pe1.executeCommand('show running-config');
    expect(after).not.toContain('l2 vfi');
    expect(await whileTimePasses(ce1.executeCommand('ping -c 1 -W 1 192.168.0.2'))).toContain('0 received');
  });

  it('WITNESS: forms nothing evaluates are refused (undefined VFI, l2tpv3, no-split-horizon)', async () => {
    const { pe1 } = await lab();
    const out = await run(pe1, ['interface GigabitEthernet0/0', 'xconnect vfi UNDEFINED', 'exit',
      'l2 vfi X manual', 'neighbor 3.3.3.3 encapsulation l2tpv3', 'neighbor 3.3.3.3 encapsulation mpls no-split-horizon']);
    expect(out[1]).toContain('Invalid input');
    expect(out[4]).toContain('Invalid input');
    expect(out[5]).toContain('Invalid input');
  });
});
