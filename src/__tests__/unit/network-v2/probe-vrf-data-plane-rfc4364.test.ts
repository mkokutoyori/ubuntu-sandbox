/**
 * Probe: VRFs as real forwarding instances (docs/rfc/mpls/rfc4364.txt §3.1,
 * §3.2). A VRF interface looks destinations up in ITS table; connected
 * routes of a VRF interface are not public routes. The configuration side
 * (ip vrf, ip vrf forwarding, ip route vrf) already existed and stored
 * names only: a ping across two VRFs of one router succeeded.
 * Before the fix 6 of the 8 cases fail (the packet crosses VRFs, `ping vrf`
 * is refused, `show ip route vrf` knows no connected routes); the same-VRF
 * case is the witness and the ping to the interface's own address passes
 * either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function lab(secondVrf: 'RED' | 'BLUE') {
  const router = new CiscoRouter('PE1');
  const pcA = new LinuxPC('linux-pc', 'A');
  const pcB = new LinuxPC('linux-pc', 'B');
  new Cable('a').connect(pcA.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(pcB.getPort('eth0')!, router.getPort('GigabitEthernet0/1')!);
  await run(router, [
    'ip vrf RED', 'exit', 'ip vrf BLUE', 'exit',
    'interface GigabitEthernet0/0', 'ip vrf forwarding RED', 'ip address 10.1.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip vrf forwarding ${secondVrf}`, 'ip address 10.2.2.1 255.255.255.0', 'no shutdown', 'exit',
  ]);
  await pcA.executeCommand('sudo ip addr add 10.1.1.10/24 dev eth0');
  await pcA.executeCommand('sudo ip route add default via 10.1.1.1');
  await pcB.executeCommand('sudo ip addr add 10.2.2.10/24 dev eth0');
  await pcB.executeCommand('sudo ip route add default via 10.2.2.1');
  return { router, pcA, pcB };
}

describe('forwarding inside one VRF', () => {
  it('WITNESS: two interfaces of the same VRF forward between each other', async () => {
    const { pcA } = await lab('RED');
    expect(await pcA.executeCommand('ping -c 2 -W 1 10.2.2.10')).toContain('2 received');
  });
});

describe('isolation between VRFs (§3.1, §3.2)', () => {
  it('two directly connected subnets in different VRFs do not reach each other', async () => {
    const { pcA } = await lab('BLUE');
    expect(await pcA.executeCommand('ping -c 2 -W 1 10.2.2.10')).toContain('100% packet loss');
  });

  it('a host reaches the router address of its own VRF interface only', async () => {
    const { pcA } = await lab('BLUE');
    expect(await pcA.executeCommand('ping -c 1 -W 1 10.1.1.1')).toContain('1 received');
  });

  it('the connected routes of a VRF interface are not in the default table', async () => {
    const { router } = await lab('BLUE');
    expect(await router.executeCommand('ping 10.1.1.10')).toContain('Success rate is 0 percent');
    const global = await router.executeCommand('show ip route');
    expect(global).not.toContain('10.1.1.0');
    expect(global).not.toContain('10.2.2.0');
  });
});

describe('ping vrf and show ip route vrf', () => {
  it('ping vrf RED reaches the RED host, ping vrf BLUE does not', async () => {
    const { router } = await lab('BLUE');
    expect(await router.executeCommand('ping vrf RED 10.1.1.10')).toContain('Success rate is 100 percent');
    expect(await router.executeCommand('ping vrf BLUE 10.1.1.10')).toContain('Success rate is 0 percent');
  });

  it('ping vrf names an unknown VRF', async () => {
    const { router } = await lab('BLUE');
    expect(await router.executeCommand('ping vrf GREEN 10.1.1.10')).toContain('% VRF GREEN not configured');
  });

  it('show ip route vrf lists the connected and local routes of that VRF only', async () => {
    const { router } = await lab('BLUE');
    const red = await router.executeCommand('show ip route vrf RED');
    expect(red).toContain('Routing Table: RED');
    expect(red).toMatch(/C\s+10\.1\.1\.0\/24 is directly connected, GigabitEthernet0\/0/);
    expect(red).not.toContain('10.2.2.0');
    const blue = await router.executeCommand('show ip route vrf BLUE');
    expect(blue).toMatch(/C\s+10\.2\.2\.0\/24 is directly connected, GigabitEthernet0\/1/);
  });

  it('a static route of a VRF is used by that VRF only', async () => {
    const { router, pcA } = await lab('BLUE');
    await run(router, ['ip route vrf BLUE 10.1.1.0 255.255.255.0 10.2.2.10']);
    expect(await router.executeCommand('show ip route vrf BLUE')).toMatch(/S\s+10\.1\.1\.0\/24/);
    expect(await router.executeCommand('show ip route vrf RED')).not.toMatch(/S\s+10\.1\.1\.0\/24/);
    expect(await pcA.executeCommand('ping -c 1 -W 1 10.2.2.10')).toContain('100% packet loss');
  });
});
