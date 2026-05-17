/**
 * Huawei switch LAN scenario — a real little network: two Linux PCs and
 * two Windows PCs cabled to a Huawei S5720. The switch is a pure LAYER-2
 * device in this project (no routing): we segment hosts into VLANs,
 * assign IPs from the hosts, prove intra-VLAN reachability and inter-VLAN
 * ISOLATION (which is the correct L2 behaviour — crossing VLANs would
 * need an external router, out of the switch's scope). Any Vlanif/L3
 * config is exercised only to confirm the L2 switch rejects/ignores it.
 * MAC/ARP tables are inspected throughout.
 *
 * 64 steps spanning the switch CLI + Linux/Windows host shells.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpHuawei, resetSim, type HuaweiStepInput } from './_huawei-suite';

describe('debug-dump: huawei-lan-connectivity', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();

    const steps: HuaweiStepInput[] = [
      // ── switch baseline ──
      { section: 'switch baseline', on: 'sw', cmd: 'display interface brief' },
      { on: 'sw', cmd: 'display mac-address' },
      { on: 'sw', cmd: 'system-view' },
      { on: 'sw', cmd: 'sysname SW-LAB' },

      // ── VLAN plan: 10=L1/W1, 20=L2/W2 ──
      { section: 'create VLANs', on: 'sw', cmd: 'vlan batch 10 20' },
      { on: 'sw', cmd: 'vlan 10' },
      { on: 'sw', cmd: 'name RED' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'vlan 20' },
      { on: 'sw', cmd: 'name BLUE' },
      { on: 'sw', cmd: 'quit' },

      { section: 'access ports → VLANs', on: 'sw', cmd: 'interface GigabitEthernet0/0/1' },
      { on: 'sw', cmd: 'port link-type access' },
      { on: 'sw', cmd: 'port default vlan 10' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'interface GigabitEthernet0/0/2' },
      { on: 'sw', cmd: 'port link-type access' },
      { on: 'sw', cmd: 'port default vlan 10' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'interface GigabitEthernet0/0/3' },
      { on: 'sw', cmd: 'port link-type access' },
      { on: 'sw', cmd: 'port default vlan 20' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'interface GigabitEthernet0/0/10' },
      { on: 'sw', cmd: 'port link-type access' },
      { on: 'sw', cmd: 'port default vlan 20' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'return' },
      { on: 'sw', cmd: 'display vlan' },
      { on: 'sw', cmd: 'display port vlan' },

      // ── host addressing (VLAN10: 192.168.10.0/24, VLAN20: 192.168.20.0/24) ──
      { section: 'host IPs — Linux', on: 'linux1', cmd: 'ifconfig eth0 192.168.10.11 netmask 255.255.255.0' },
      { on: 'linux1', cmd: 'ip addr show eth0' },
      { on: 'linux2', cmd: 'ifconfig eth0 192.168.20.12 netmask 255.255.255.0' },
      { on: 'linux2', cmd: 'ip addr show eth0' },
      { section: 'host IPs — Windows', on: 'win1', cmd: 'netsh interface ip set address "Ethernet" static 192.168.10.21 255.255.255.0' },
      { on: 'win1', cmd: 'ipconfig' },
      { on: 'win2', cmd: 'netsh interface ip set address "Ethernet" static 192.168.20.22 255.255.255.0' },
      { on: 'win2', cmd: 'ipconfig' },

      // ── intra-VLAN reachability (should succeed) ──
      { section: 'intra-VLAN ping (expect OK)', on: 'linux1', cmd: 'ping -c 2 192.168.10.21' },
      { on: 'win1', cmd: 'ping -n 2 192.168.10.11' },
      { on: 'linux2', cmd: 'ping -c 2 192.168.20.22' },
      { on: 'win2', cmd: 'ping -n 2 192.168.20.12' },

      // ── inter-VLAN isolation: CORRECT on an L2 switch (no routing) ──
      { section: 'inter-VLAN ping (expect FAIL — L2 switch never routes)', on: 'linux1', cmd: 'ping -c 2 192.168.20.12' },
      { on: 'win1', cmd: 'ping -n 2 192.168.20.22' },

      // ── switch learned state ──
      { section: 'switch L2 tables', on: 'sw', cmd: 'display mac-address' },
      { on: 'sw', cmd: 'display mac-address vlan 10' },
      { on: 'sw', cmd: 'display mac-address vlan 20' },
      { on: 'sw', cmd: 'display interface GigabitEthernet0/0/1' },

      // ── L3/SVI on an L2 switch: expected to be rejected/ignored ──
      // (kept as gap analysis — confirms the switch does NOT become a
      //  router; inter-VLAN would require a separate L3 device.)
      { section: 'Vlanif/L3 on L2 switch (expect rejected/ignored)', on: 'sw', cmd: 'system-view' },
      { on: 'sw', cmd: 'interface Vlanif10' },
      { on: 'sw', cmd: 'ip address 192.168.10.1 255.255.255.0' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'interface Vlanif20' },
      { on: 'sw', cmd: 'ip address 192.168.20.1 255.255.255.0' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'return' },
      { on: 'sw', cmd: 'display ip interface brief' },
      { on: 'sw', cmd: 'display ip routing-table' },

      // ── even with host gateways set, inter-VLAN STAYS isolated ──
      // (correct: an L2 switch has no SVI/route to forward between VLANs)
      { section: 'host gateways set — inter-VLAN STILL isolated (L2)', on: 'linux1', cmd: 'route add default gw 192.168.10.1' },
      { on: 'linux2', cmd: 'route add default gw 192.168.20.1' },
      { on: 'linux1', cmd: 'ping -c 2 192.168.20.12' },
      { on: 'linux1', cmd: 'traceroute 192.168.20.12' },
      { on: 'linux1', cmd: 'arp -a' },
      { on: 'win1', cmd: 'route add 0.0.0.0 mask 0.0.0.0 192.168.10.1' },
      { on: 'win1', cmd: 'ping -n 2 192.168.20.22' },
      { on: 'win1', cmd: 'arp -a' },

      // ── final inspection ──
      { section: 'final switch state', on: 'sw', cmd: 'display mac-address' },
      { on: 'sw', cmd: 'display current-configuration' },
    ];

    await dumpHuawei(
      'huawei-lan-connectivity',
      topology,
      steps,
      'focus=L2 switch: VLAN segmentation, intra-VLAN reachability, inter-VLAN isolation (no routing)',
    );
  }, 120000);
});
