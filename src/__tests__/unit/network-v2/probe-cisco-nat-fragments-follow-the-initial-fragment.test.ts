/*
 * Reference: official_docs/cisco/ios-security (Cisco IOS Security Command Reference, `ip virtual-reassembly`: max-reassemblies default 16, max-fragments default 32, timeout 0 to 60 seconds default 3,
 * drop-fragments; "NAT enables and disables VFR internally ... when NAT is enabled on an interface, VFR is automatically enabled on that interface"; `show ip virtual-reassembly` sample output) and the
 * Cisco "Virtual Fragmentation Reassembly" configuration guide (initial and noninitial fragment, overlapping fragment attack: all fragments of the chain are dropped, VFR-3-OVERLAP_FRAGMENT;
 * VFR-4_FRAG_TABLE_OVERFLOW and VFR-4_TOO_MANY_FRAGMENTS).
 *
 * Measured at the start (R-AGENCE, the PAT router of the Banque Horizon lab, PC-GUICHET1 behind it): `ping -l 1472` answered, `ping -l 1500` / 3000 / 8000 timed out. The log showed both request fragments
 * translated and both reply fragments forwarded by R-ISP, then one single forward by R-AGENCE: a noninitial fragment carries no ICMP identifier, NATEngine could not find its session and left it addressed to
 * the router. The outbound direction was worse: the noninitial request fragment created a bogus session (`icmp 192.0.2.2:1024  10.20.10.50:0`) in `show ip nat translations`. Now a noninitial fragment follows
 * the rewrite of its initial fragment and never creates a session.
 *
 * Measured against the commit before (git stash of src/network and src/cli): see the commit message for the count; the cases that pass either way are the WITNESSES (a datagram that fits in one frame, and the
 * lab's own interfaces) named in the cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress, IPAddress, IP_PROTO_ICMP, createIPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';
import { VirtualReassembly } from '@/network/devices/router/VirtualReassembly';
import type { IPv4Packet } from '@/network/core/types';

interface Shell { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  await buildDnsAgenceBancaire();
  const find = (name: string) => [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === name) as unknown as Shell;
  const pc = find('PC-GUICHET1');
  const router = find('R-AGENCE');
  const ping = async (size: number) => /Reply from/.test(await pc.executeCommand(`ping -n 1 -l ${size} 203.0.113.20`));
  const configure = async (interfaceName: string, ...lines: string[]) => {
    for (const line of ['enable', 'configure terminal', `interface ${interfaceName}`, ...lines, 'end']) await router.executeCommand(line);
  };
  return { router, ping, configure };
}

function fragment(id: number, offsetBytes: number, bytes: number, moreFragments: boolean): IPv4Packet {
  const packet = createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'), IP_PROTO_ICMP, 64, null, bytes);
  return { ...packet, identification: id, fragmentOffset: offsetBytes / 8, flags: moreFragments ? 0b001 : 0 };
}

describe('a NAT router translates the noninitial fragments with their initial fragment', () => {
  it('WITNESS a datagram that fits in one frame crosses the PAT router', async () => {
    const { ping } = await lab();
    expect(await ping(1400)).toBe(true);
  });

  it.each([1500, 3000, 8000])('an echo of %i bytes is answered through the PAT router', async (size) => {
    const { ping } = await lab();
    expect(await ping(size)).toBe(true);
  });

  it('a fragmented echo creates one session per echo and no session with identifier 0', async () => {
    const { router, ping } = await lab();
    expect(await ping(3000)).toBe(true);
    const table = await router.executeCommand('show ip nat translations');
    expect(table).not.toMatch(/:0\s/);
    expect(table.match(/^icmp /gm)).toHaveLength(1);
  });
});

describe('VFR is enabled by NAT and configured by ip virtual-reassembly', () => {
  it('shows the defaults of the command reference on the NAT interfaces only', async () => {
    const { router } = await lab();
    const out = await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/0');
    expect(out.split('\n').slice(0, 6)).toEqual([
      'GigabitEthernet0/0:',
      'Virtual Fragment Reassembly (VFR) is ENABLED...',
      'Concurrent reassemblies (max-reassemblies):16',
      'Fragments per reassembly (max-fragments):32',
      'Reassembly timeout (timeout):3 seconds',
      'Drop fragments:OFF',
    ]);
    expect(await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/2')).toBe('');
  });

  it('counts the datagrams it has reassembled', async () => {
    const { router, ping } = await lab();
    await ping(3000);
    expect(await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/0')).toContain('Total reassembly count:1');
  });

  it('keeps the configured values, shows them, and writes them in the running configuration', async () => {
    const { router, configure } = await lab();
    await configure('GigabitEthernet0/0', 'ip virtual-reassembly max-reassemblies 64 max-fragments 16 timeout 5');
    const shown = await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/0');
    expect(shown).toContain('Concurrent reassemblies (max-reassemblies):64');
    expect(shown).toContain('Fragments per reassembly (max-fragments):16');
    expect(shown).toContain('Reassembly timeout (timeout):5 seconds');
    expect(await router.executeCommand('show running-config interface GigabitEthernet0/0'))
      .toContain(' ip virtual-reassembly max-reassemblies 64 max-fragments 16 timeout 5');
  });

  it('does not write in the running configuration what NAT enabled by itself', async () => {
    const { router } = await lab();
    expect(await router.executeCommand('show running-config interface GigabitEthernet0/0')).not.toContain('virtual-reassembly');
  });

  it('refuses a timeout above 60 seconds, which the command reference does not allow', async () => {
    const { router, configure } = await lab();
    await configure('GigabitEthernet0/2', 'ip virtual-reassembly timeout 90');
    expect(await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/2')).toBe('');
  });

  it('max-fragments 2 drops a three-fragment datagram, and the failure is counted', async () => {
    const { router, ping, configure } = await lab();
    await configure('GigabitEthernet0/1.10', 'ip virtual-reassembly max-fragments 2');
    expect(await ping(3000)).toBe(false);
    expect(await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/1.10')).toMatch(/Total reassembly failures:[1-9]/);
    expect(await ping(1400)).toBe(true);
  });

  it('drop-fragments drops every fragment that arrives on the interface and nothing else', async () => {
    const { router, ping, configure } = await lab();
    await configure('GigabitEthernet0/0', 'ip virtual-reassembly drop-fragments');
    expect(await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/0')).toContain('Drop fragments:ON');
    expect(await ping(3000)).toBe(false);
    expect(await ping(1400)).toBe(true);
  });

  it('no ip virtual-reassembly returns the interface to what NAT enabled', async () => {
    const { router, configure } = await lab();
    await configure('GigabitEthernet0/0', 'ip virtual-reassembly max-fragments 2', 'no ip virtual-reassembly');
    const shown = await router.executeCommand('show ip virtual-reassembly interface GigabitEthernet0/0');
    expect(shown).toContain('Fragments per reassembly (max-fragments):32');
  });
});

describe('the reassembly table of VFR', () => {
  const enabled = () => {
    const vfr = new VirtualReassembly();
    vfr.configure('eth0', { maxReassemblies: 2, maxFragments: 3, timeoutSeconds: 3 });
    return vfr;
  };

  it('lets the fragments of a datagram pass and counts it as reassembled when the last one arrives', () => {
    const vfr = enabled();
    expect(vfr.observe('eth0', fragment(1, 0, 1480, true))).toEqual({ pass: true });
    expect(vfr.snapshot('eth0')?.currentReassemblies).toBe(1);
    expect(vfr.observe('eth0', fragment(1, 1480, 100, false))).toEqual({ pass: true });
    expect(vfr.snapshot('eth0')).toMatchObject({ currentReassemblies: 0, totalReassemblies: 1, totalFailures: 0 });
  });

  it('drops the whole chain when a fragment overlaps another, with VFR-3-OVERLAP_FRAGMENT', () => {
    const vfr = enabled();
    vfr.observe('eth0', fragment(7, 0, 1480, true));
    expect(vfr.observe('eth0', fragment(7, 1400, 200, true))).toEqual({ pass: false, alert: 'VFR-3-OVERLAP_FRAGMENT' });
    expect(vfr.observe('eth0', fragment(7, 1480, 100, false))).toEqual({ pass: false });
    expect(vfr.snapshot('eth0')).toMatchObject({ currentReassemblies: 0, totalFailures: 1 });
  });

  it('drops the fragments of a datagram that does not fit in the table, with VFR-4_FRAG_TABLE_OVERFLOW', () => {
    const vfr = enabled();
    vfr.observe('eth0', fragment(1, 0, 1480, true));
    vfr.observe('eth0', fragment(2, 0, 1480, true));
    expect(vfr.observe('eth0', fragment(3, 0, 1480, true))).toEqual({ pass: false, alert: 'VFR-4_FRAG_TABLE_OVERFLOW' });
    expect(vfr.observe('eth0', fragment(3, 1480, 100, false))).toEqual({ pass: false });
    expect(vfr.observe('eth0', fragment(1, 1480, 100, false))).toEqual({ pass: true });
  });

  it('drops a datagram that receives more fragments than allowed, with VFR-4_TOO_MANY_FRAGMENTS', () => {
    const vfr = enabled();
    vfr.observe('eth0', fragment(5, 0, 800, true));
    vfr.observe('eth0', fragment(5, 800, 800, true));
    vfr.observe('eth0', fragment(5, 1600, 800, true));
    expect(vfr.observe('eth0', fragment(5, 2400, 800, false))).toEqual({ pass: false, alert: 'VFR-4_TOO_MANY_FRAGMENTS' });
  });

  it('ignores whole datagrams and interfaces where VFR is not enabled', () => {
    const vfr = enabled();
    expect(vfr.observe('eth0', fragment(1, 0, 100, false))).toEqual({ pass: true });
    expect(vfr.observe('eth1', fragment(1, 0, 1480, true))).toEqual({ pass: true });
    expect(vfr.snapshot('eth1')).toBeNull();
  });

  it('keeps VFR enabled while one feature still needs it (reference count)', () => {
    const vfr = new VirtualReassembly();
    vfr.retain('eth0');
    vfr.retain('eth0');
    vfr.release('eth0');
    expect(vfr.isEnabled('eth0')).toBe(true);
    vfr.release('eth0');
    expect(vfr.isEnabled('eth0')).toBe(false);
  });
});
