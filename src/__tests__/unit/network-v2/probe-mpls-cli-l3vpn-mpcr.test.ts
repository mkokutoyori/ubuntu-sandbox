/**
 * Probe: the layer 3 VPN views of the Cisco MPLS Command Reference (mp-cr-book):
 * show ip vrf [brief|detail|interfaces] [name], show vrf [brief|detail],
 * show ip bgp vpnv4 {all|rd|vrf} [labels|summary].
 * CE1 - PE1 - P - PE2 - CE2 as in probe-l3vpn-rfc4364.
 * Before the fix 10 of the 12 cases fail (no per-VRF Route Distinguisher
 * header, no label view, no vpnv4 summary, no "does not exist" refusal, no
 * detail block). Two pass either way: the P router without VRF (witness) and
 * the vrf/rd equality, which is vacuous before the fix (two refusals are
 * equal) and is anchored by the "all" case that checks the table itself.
 * WITNESS: a router without VRF lists no VRF, so the lab is what makes the
 * lines appear.
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

async function lab(options: { importRt2: string } = { importRt2: '65000:1' }) {
  const ce1 = new LinuxPC('linux-pc', 'CE1');
  const ce2 = new LinuxPC('linux-pc', 'CE2');
  const pe1 = new CiscoRouter('PE1');
  const p = new CiscoRouter('P');
  const pe2 = new CiscoRouter('PE2');
  new Cable('a').connect(ce1.getPort('eth0')!, pe1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(pe1.getPort('GigabitEthernet0/1')!, p.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(p.getPort('GigabitEthernet0/1')!, pe2.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(pe2.getPort('GigabitEthernet0/1')!, ce2.getPort('eth0')!);
  await run(pe1, [
    'ip vrf RED', 'rd 65000:1', 'route-target export 65000:1', 'route-target import 65000:1', 'exit',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip vrf forwarding RED', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2',
    'ip route 10.23.0.0 255.255.255.0 10.12.0.2',
  ]);
  await run(p, [
    'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3',
  ]);
  await run(pe2, [
    'ip vrf RED', 'rd 65000:1', 'route-target export 65000:1', `route-target import ${options.importRt2}`, 'exit',
    'interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip vrf forwarding RED', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2',
    'ip route 10.12.0.0 255.255.255.0 10.23.0.2',
  ]);
  await ce1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await ce1.executeCommand('sudo ip route add default via 192.168.1.1');
  await ce2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await ce2.executeCommand('sudo ip route add default via 192.168.2.1');
  for (const [router, iface] of [[pe1, 'GigabitEthernet0/1'], [p, 'GigabitEthernet0/0'], [p, 'GigabitEthernet0/1'], [pe2, 'GigabitEthernet0/0']] as const) {
    router.getLdpEngine().enableInterface(iface);
  }
  clock.advance(6000);
  for (const [router, asn, peer] of [[pe1, 65000, '3.3.3.3'], [pe2, 65000, '1.1.1.1']] as const) {
    await run(router, [`router bgp ${asn}`]);
    router.getBGPEngine().getConfig().neighbors.set(peer, { ip: peer, remoteAs: asn, activated: true, updateSource: 'Loopback0', vpnv4: true });
    router.setVrfBgpRedistribution('RED', ['connected']);
    router.convergeDynamicRouting();
  }
  pe1.convergeDynamicRouting();
  pe2.convergeDynamicRouting();
  clock.advance(10000);
  pe1.convergeDynamicRouting();
  pe2.convergeDynamicRouting();
  return { ce1, ce2, pe1, p, pe2 };
}



describe('show ip vrf / show vrf', () => {
  it('brief lists the VRF with its Default RD and interface', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip vrf');
    expect(out).toContain('Name                             Default RD            Interfaces');
    expect(out).toMatch(/RED\s+65000:1\s+Gi0\/0/);
  });

  it('detail prints the route targets and the label allocation mode', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip vrf detail');
    expect(out).toContain('VRF RED; default RD 65000:1; default VPNID <not set>');
    expect(out).toContain('Export VPN route-target communities\n    RT:65000:1');
    expect(out).toContain('VRF label allocation mode: per-prefix');
  });

  it('interfaces lists address, VRF and protocol state', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip vrf interfaces');
    expect(out).toContain('Interface              IP-Address      VRF                              Protocol');
    expect(out).toMatch(/Gi0\/0\s+192\.168\.1\.1\s+RED\s+up/);
  });

  it('an unknown VRF is refused in IOS words', async () => {
    const { pe1 } = await lab();
    expect(await pe1.executeCommand('show ip vrf NOPE')).toBe('% VRF NOPE does not exist');
  });

  it('show vrf adds the Protocols column and detail the address family', async () => {
    const { pe1 } = await lab();
    expect(await pe1.executeCommand('show vrf')).toMatch(/RED\s+65000:1\s+ipv4\s+Gi0\/0/);
    expect(await pe1.executeCommand('show vrf detail')).toContain('Address family ipv4 (Table ID = 0x1):');
  });

  it('WITNESS: a router without VRF has no VRF line', async () => {
    const { p } = await lab();
    expect(await p.executeCommand('show ip vrf')).not.toContain('RED');
  });
});

describe('show ip bgp vpnv4', () => {
  it('all groups the routes under their Route Distinguisher and names the VRF', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip bgp vpnv4 all');
    expect(out).toContain('Route Distinguisher: 65000:1 (default for vrf RED)');
    expect(out).toMatch(/\*> 192\.168\.1\.0\/24\s+0\.0\.0\.0\s+0\s+32768 \?/);
    expect(out).toMatch(/\*>i192\.168\.2\.0\/24\s+3\.3\.3\.3\s+0\s+100\s+0 \?/);
    expect(out).toContain('BGP table version is');
  });

  it('vrf and rd select the same table', async () => {
    const { pe1 } = await lab();
    const all = await pe1.executeCommand('show ip bgp vpnv4 all');
    expect(await pe1.executeCommand('show ip bgp vpnv4 vrf RED')).toBe(all);
    expect(await pe1.executeCommand('show ip bgp vpnv4 rd 65000:1')).toBe(all);
  });

  it('an unknown VRF is refused', async () => {
    const { pe1 } = await lab();
    expect(await pe1.executeCommand('show ip bgp vpnv4 vrf NOPE')).toBe('% VRF NOPE does not exist');
  });

  it('labels shows the In and Out VPN label of each prefix', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip bgp vpnv4 all labels');
    expect(out).toContain('In label/Out label');
    expect(out).toMatch(/192\.168\.1\.0\/24\s+0\.0\.0\.0\s+\d+\/nolabel/);
    expect(out).toMatch(/192\.168\.2\.0\/24\s+3\.3\.3\.3\s+nolabel\/\d+/);
  });

  it('summary lists the vpnv4 neighbour with its received prefix count', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip bgp vpnv4 all summary');
    expect(out).toContain('BGP router identifier 1.1.1.1, local AS number 65000');
    expect(out).toMatch(/3\.3\.3\.3\s+4\s+65000\s+[1-9]\d*\s+[1-9]\d*\s+0\s+0\s+0\s+\S+\s+1\s*$/);
  });

  it('WITNESS: a bare "show ip bgp vpnv4" is incomplete', async () => {
    const { pe1 } = await lab();
    expect(await pe1.executeCommand('show ip bgp vpnv4')).toBe('% Incomplete command.');
  });
});
