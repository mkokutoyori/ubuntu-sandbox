/**
 * Probe: a layer 3 VPN end to end (docs/rfc/mpls/rfc4364.txt §3-§5).
 * CE1 - PE1 - P - PE2 - CE2. The P router has no VRF and no route toward the
 * customer prefixes: only the labels carry the traffic. The PEs peer over
 * iBGP between loopbacks (update-source), exchange VPN-IPv4 routes (RD, RT,
 * VPN label) in MP_REACH_NLRI, and import by Route Target.
 * New subsystem: every case fails before (no VPN-IPv4 family, no import).
 * Witnesses: the same lab with distinct RTs (no import) shows the lab is
 * sound and the filter is what decides.
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

describe('MP-BGP VPN-IPv4 between the PEs (§4)', () => {
  it('the iBGP session between the loopbacks comes up and negotiates the VPN-IPv4 family', async () => {
    const { pe1, pe2 } = await lab();
    expect(pe1.getBGPEngine().messageCountsFor('3.3.3.3').received).toBeGreaterThan(0);
    expect(pe1.getBGPEngine().vpnSpeaker()!.receivedCount('3.3.3.3')).toBeGreaterThan(0);
  });

  it('PE1 imports the remote customer prefix into the VRF with a VPN label and the BGP next hop (§4.3.2)', async () => {
    const { pe1 } = await lab();
    const route = pe1.vrfRouteTable('RED').find(r => String(r.network) === '192.168.2.0');
    expect(route).toMatchObject({ type: 'bgp' });
    expect(String(route!.vpn!.bgpNextHop)).toBe('3.3.3.3');
    expect(route!.vpn!.label.value).toBeGreaterThanOrEqual(16);
  });

  it('WITNESS: a different import Route Target keeps the prefix out of the VRF (§4.3.1)', async () => {
    const { pe2 } = await lab({ importRt2: '65000:99' });
    expect(pe2.vrfRouteTable('RED').some(r => r.type === 'bgp')).toBe(false);
  });

  it('show ip route vrf RED lists the BGP route learned from the other PE', async () => {
    const { pe1 } = await lab();
    const out = await pe1.executeCommand('show ip route vrf RED');
    expect(out).toMatch(/B\s+192\.168\.2\.0\/24/);
  });
});

describe('forwarding with a two-label stack (§5)', () => {
  it('CE1 reaches CE2; the P router switched by label and has no customer route', async () => {
    const { ce1, p, pe1, pe2 } = await lab();
    const out = await whileTimePasses(ce1.executeCommand('ping -c 3 -W 1 192.168.2.10'));
    expect(out).toContain('3 received');
    expect(p.getMplsEngine().counters.labelledIn).toBeGreaterThanOrEqual(3);
    expect(p.getRoutingTable().some(r => String(r.network).startsWith('192.168.'))).toBe(false);
    expect(pe1.getMplsEngine().counters.imposed).toBeGreaterThanOrEqual(3);
    expect(pe2.getMplsEngine().counters.disposed).toBeGreaterThanOrEqual(3);
  });

  it('the packet leaves PE1 with transport label then VPN label (stack depth 2) when the P router is not the penultimate hop', async () => {
    const { ce1, pe1 } = await lab();
    const seen: number[] = [];
    const engine = pe1.getMplsEngine();
    const original = engine.imposeVpn.bind(engine);
    engine.imposeVpn = (...args) => { const packet = original(...args); if (packet) seen.push(packet.stack.length); return packet; };
    await whileTimePasses(ce1.executeCommand('ping -c 1 -W 1 192.168.2.10'));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([2]));
  });

  it('WITNESS: without the import the ping fails', async () => {
    const { ce1 } = await lab({ importRt2: '65000:99' });
    const out = await whileTimePasses(ce1.executeCommand('ping -c 1 -W 1 192.168.2.10'));
    expect(out).toContain('100% packet loss');
  });

  it('ping vrf RED from the PE crosses the VPN too', async () => {
    const { pe1 } = await lab();
    const out = await whileTimePasses(pe1.executeCommand('ping vrf RED 192.168.2.10'));
    expect(out).toContain('Success rate is 100 percent');
  });
});

describe('the IOS commands that build the same VPN', () => {
  async function cliLab() {
    const { ce1, ce2, pe1, p, pe2 } = await lab({ importRt2: '65000:1' });
    for (const router of [pe1, pe2]) {
      const peer = router === pe1 ? '3.3.3.3' : '1.1.1.1';
      await run(router, ['no router bgp 65000']);
      await run(router, [
        'router bgp 65000', `neighbor ${peer} remote-as 65000`, `neighbor ${peer} update-source Loopback0`,
        'address-family vpnv4', `neighbor ${peer} activate`, `neighbor ${peer} send-community extended`, 'exit-address-family',
        'address-family ipv4 vrf RED', 'redistribute connected', 'exit-address-family',
      ]);
    }
    for (let round = 0; round < 3; round++) {
      pe1.convergeDynamicRouting(); pe2.convergeDynamicRouting(); clock.advance(10000);
    }
    return { ce1, ce2, pe1, p, pe2 };
  }

  it('the configuration typed on both PEs brings the VPN up and CE1 reaches CE2', async () => {
    const { ce1, pe1 } = await cliLab();
    expect(pe1.vrfRouteTable('RED').some(r => r.type === 'bgp')).toBe(true);
    expect(await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.2.10'))).toContain('2 received');
  });

  it('show running-config writes the address families back', async () => {
    const { pe1 } = await cliLab();
    const config = await pe1.executeCommand('show running-config');
    expect(config).toContain(' neighbor 3.3.3.3 update-source Loopback0');
    expect(config).toContain(' address-family vpnv4\n  neighbor 3.3.3.3 activate\n  neighbor 3.3.3.3 send-community extended\n exit-address-family');
    expect(config).toContain(' address-family ipv4 vrf RED\n  redistribute connected\n exit-address-family');
  });

  it('address-family ipv4 vrf names an unknown VRF', async () => {
    const { pe1 } = await cliLab();
    await pe1.executeCommand('enable');
    await pe1.executeCommand('configure terminal');
    await pe1.executeCommand('router bgp 65000');
    expect(await pe1.executeCommand('address-family ipv4 vrf GREEN')).toContain('% VRF GREEN not configured');
  });
});
