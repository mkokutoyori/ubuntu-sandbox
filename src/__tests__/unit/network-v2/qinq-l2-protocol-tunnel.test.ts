import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('802.1Q Phase 5 — Cisco L2 protocol tunneling (l2protocol-tunnel stp)', () => {
  async function provider(withTunnel: boolean): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('switch-cisco', 'PROVIDER', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode dot1q-tunnel');
    await sw.executeCommand('switchport access vlan 500');
    if (withTunnel) await sw.executeCommand('l2protocol-tunnel stp');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode dot1q-tunnel');
    await sw.executeCommand('switchport access vlan 500');
    if (withTunnel) await sw.executeCommand('l2protocol-tunnel stp');
    await sw.executeCommand('end');
    return sw;
  }

  async function clientA(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('switch-cisco', 'CLIENT-A', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('spanning-tree vlan 1 priority 4096');
    await sw.executeCommand('end');
    return sw;
  }

  it('the provider relays client STP BPDUs transparently, with no local root election on the S-VLAN', async () => {
    const p = await provider(true);
    const a = await clientA();
    const b = new CiscoSwitch('switch-cisco', 'CLIENT-B', 8);

    new Cable('p-b').connect(p.getPort('FastEthernet0/2')!, b.getPort('FastEthernet0/1')!);
    new Cable('a-p').connect(a.getPort('FastEthernet0/1')!, p.getPort('FastEthernet0/1')!);

    // The provider never hands the client's BPDU to its own bridge — no
    // real neighbor was ever seen on the S-VLAN, so it stays self-root.
    expect(p.getStpAgent().isRoot()).toBe(true);

    // Yet the two clients see each other end-to-end, as if directly wired.
    // 4097, not 4096: real Cisco PVST+ extended system ID folds the VLAN
    // number (1) into the low 12 bits of the advertised bridge priority
    // (StpAgent.extendedSystemId/cstKey — PVST+/RSTP mode keys on VLAN 1).
    expect(b.getStpAgent().getRootBridge().priority).toBe(4097);
    expect(b.getStpAgent().getRootPort()).toBe('FastEthernet0/1');
  });

  it('without l2protocol-tunnel stp, the provider instead terminates the BPDU locally (regression control)', async () => {
    const p = await provider(false);
    const a = await clientA();
    const b = new CiscoSwitch('switch-cisco', 'CLIENT-B', 8);

    new Cable('a-p').connect(a.getPort('FastEthernet0/1')!, p.getPort('FastEthernet0/1')!);
    new Cable('p-b').connect(p.getPort('FastEthernet0/2')!, b.getPort('FastEthernet0/1')!);

    // Client A's superior BPDU is processed directly by the provider's own
    // bridge this time, so it loses the local root election.
    expect(p.getStpAgent().isRoot()).toBe(false);
  });
});

describe('802.1Q Phase 5 — Huawei L2 protocol tunneling (bpdu-tunnel stp enable)', () => {
  async function provider(withTunnel: boolean): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'PROVIDER', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 500');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('qinq enable');
    await sw.executeCommand('port default vlan 500');
    if (withTunnel) await sw.executeCommand('bpdu-tunnel stp enable');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('qinq enable');
    await sw.executeCommand('port default vlan 500');
    if (withTunnel) await sw.executeCommand('bpdu-tunnel stp enable');
    await sw.executeCommand('quit');
    return sw;
  }

  async function clientA(): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'CLIENT-A', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('stp priority 4096');
    await sw.executeCommand('quit');
    return sw;
  }

  it('the provider relays client STP BPDUs transparently, with no local root election on the S-VLAN', async () => {
    const p = await provider(true);
    const a = await clientA();
    const b = new HuaweiSwitch('switch-huawei', 'CLIENT-B', 8);

    new Cable('p-b').connect(p.getPort('GigabitEthernet0/0/2')!, b.getPort('GigabitEthernet0/0/1')!);
    new Cable('a-p').connect(a.getPort('GigabitEthernet0/0/1')!, p.getPort('GigabitEthernet0/0/1')!);

    expect(p.getStpAgent().isRoot()).toBe(true);
    expect(b.getStpAgent().getRootBridge().priority).toBe(4096);
    expect(b.getStpAgent().getRootPort()).toBe('GigabitEthernet0/0/1');
  });

  it('without bpdu-tunnel stp enable, the provider instead terminates the BPDU locally (regression control)', async () => {
    const p = await provider(false);
    const a = await clientA();
    const b = new HuaweiSwitch('switch-huawei', 'CLIENT-B', 8);

    new Cable('a-p').connect(a.getPort('GigabitEthernet0/0/1')!, p.getPort('GigabitEthernet0/0/1')!);
    new Cable('p-b').connect(p.getPort('GigabitEthernet0/0/2')!, b.getPort('GigabitEthernet0/0/1')!);

    expect(p.getStpAgent().isRoot()).toBe(false);
  });
});
