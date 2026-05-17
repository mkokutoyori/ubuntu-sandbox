/**
 * Huawei switch LAN scenario — a real little network: two Linux PCs and
 * two Windows PCs cabled to a Huawei S5720. We segment them into VLANs,
 * assign IPs from the hosts, prove intra-VLAN reachability, prove
 * inter-VLAN isolation, then enable L3 SVIs for inter-VLAN routing and
 * re-test. MAC/ARP tables are inspected throughout.
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

      // ── inter-VLAN isolation (should fail: no L3 yet) ──
      { section: 'inter-VLAN ping (expect FAIL)', on: 'linux1', cmd: 'ping -c 2 192.168.20.12' },
      { on: 'win1', cmd: 'ping -n 2 192.168.20.22' },

      // ── switch learned state ──
      { section: 'switch L2 tables', on: 'sw', cmd: 'display mac-address' },
      { on: 'sw', cmd: 'display mac-address vlan 10' },
      { on: 'sw', cmd: 'display mac-address vlan 20' },
      { on: 'sw', cmd: 'display interface GigabitEthernet0/0/1' },

      // ── enable inter-VLAN routing via SVIs ──
      { section: 'inter-VLAN routing (SVI)', on: 'sw', cmd: 'system-view' },
      { on: 'sw', cmd: 'interface Vlanif10' },
      { on: 'sw', cmd: 'ip address 192.168.10.1 255.255.255.0' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'interface Vlanif20' },
      { on: 'sw', cmd: 'ip address 192.168.20.1 255.255.255.0' },
      { on: 'sw', cmd: 'quit' },
      { on: 'sw', cmd: 'return' },
      { on: 'sw', cmd: 'display ip interface brief' },
      { on: 'sw', cmd: 'display ip routing-table' },

      // ── point hosts at their gateways and re-test inter-VLAN ──
      { section: 'gateways + inter-VLAN retry', on: 'linux1', cmd: 'route add default gw 192.168.10.1' },
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
      'focus=VLAN segmentation, intra/inter-VLAN reachability, SVI routing',
    );
  }, 120000);
});
