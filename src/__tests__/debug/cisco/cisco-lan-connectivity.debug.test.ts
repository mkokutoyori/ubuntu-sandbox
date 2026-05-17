/**
 * Cisco L2 LAN scenario — two Linux + two Windows hosts on a Catalyst
 * switch, VLAN-segmented. Proves intra-VLAN reachability and inter-VLAN
 * isolation (correct on an L2-only switch — no routing). 60 steps.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpCisco, resetSim, type CiscoStepInput } from './_cisco-suite';

describe('debug-dump: cisco-lan-connectivity', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();
    const steps: CiscoStepInput[] = [
      { section: 'switch baseline', on: 'sw', cmd: 'enable' },
      { on: 'sw', cmd: 'show mac address-table' },
      { on: 'sw', cmd: 'configure terminal' },
      { on: 'sw', cmd: 'hostname SW-LAB' },

      { section: 'VLANs 10=L1/W1, 20=L2/W2', on: 'sw', cmd: 'vlan 10' },
      { on: 'sw', cmd: 'name RED' },
      { on: 'sw', cmd: 'exit' },
      { on: 'sw', cmd: 'vlan 20' },
      { on: 'sw', cmd: 'name BLUE' },
      { on: 'sw', cmd: 'exit' },

      { section: 'access ports', on: 'sw', cmd: 'interface FastEthernet0/1' },
      { on: 'sw', cmd: 'switchport mode access' },
      { on: 'sw', cmd: 'switchport access vlan 10' },
      { on: 'sw', cmd: 'exit' },
      { on: 'sw', cmd: 'interface FastEthernet0/2' },
      { on: 'sw', cmd: 'switchport mode access' },
      { on: 'sw', cmd: 'switchport access vlan 10' },
      { on: 'sw', cmd: 'exit' },
      { on: 'sw', cmd: 'interface FastEthernet0/3' },
      { on: 'sw', cmd: 'switchport mode access' },
      { on: 'sw', cmd: 'switchport access vlan 20' },
      { on: 'sw', cmd: 'exit' },
      { on: 'sw', cmd: 'interface FastEthernet0/10' },
      { on: 'sw', cmd: 'switchport mode access' },
      { on: 'sw', cmd: 'switchport access vlan 20' },
      { on: 'sw', cmd: 'end' },
      { on: 'sw', cmd: 'show vlan brief' },

      { section: 'host IPs', on: 'linux1', cmd: 'ifconfig eth0 192.168.10.11 netmask 255.255.255.0' },
      { on: 'linux2', cmd: 'ifconfig eth0 192.168.20.12 netmask 255.255.255.0' },
      { on: 'win1', cmd: 'netsh interface ip set address "Ethernet" static 192.168.10.21 255.255.255.0' },
      { on: 'win2', cmd: 'netsh interface ip set address "Ethernet" static 192.168.20.22 255.255.255.0' },
      { on: 'linux1', cmd: 'ip addr show eth0' },
      { on: 'win1', cmd: 'ipconfig' },

      { section: 'intra-VLAN ping (expect OK)', on: 'linux1', cmd: 'ping -c 2 192.168.10.21' },
      { on: 'win1', cmd: 'ping -n 2 192.168.10.11' },
      { on: 'linux2', cmd: 'ping -c 2 192.168.20.22' },
      { on: 'win2', cmd: 'ping -n 2 192.168.20.12' },

      { section: 'inter-VLAN ping (expect FAIL — L2 switch never routes)', on: 'linux1', cmd: 'ping -c 2 192.168.20.12' },
      { on: 'win1', cmd: 'ping -n 2 192.168.20.22' },

      { section: 'switch L2 tables', on: 'sw', cmd: 'show mac address-table' },
      { on: 'sw', cmd: 'show mac address-table vlan 10' },
      { on: 'sw', cmd: 'show mac address-table vlan 20' },
      { on: 'sw', cmd: 'show interfaces status' },

      { section: 'L3 on L2 switch (expect rejected)', on: 'sw', cmd: 'enable' },
      { on: 'sw', cmd: 'configure terminal' },
      { on: 'sw', cmd: 'interface Vlan10' },
      { on: 'sw', cmd: 'ip address 192.168.10.1 255.255.255.0' },
      { on: 'sw', cmd: 'exit' },
      { on: 'sw', cmd: 'ip routing' },
      { on: 'sw', cmd: 'end' },
      { on: 'sw', cmd: 'show ip route' },

      { section: 'inter-VLAN STILL isolated (L2)', on: 'linux1', cmd: 'route add default gw 192.168.10.1' },
      { on: 'linux1', cmd: 'ping -c 2 192.168.20.12' },
      { on: 'linux1', cmd: 'arp -a' },
      { on: 'win1', cmd: 'ping -n 2 192.168.20.22' },

      { section: 'final', on: 'sw', cmd: 'show mac address-table' },
      { on: 'sw', cmd: 'show running-config' },
    ];
    await dumpCisco('cisco-lan-connectivity', topology, steps,
      'focus=L2 VLAN segmentation, intra-VLAN reachability, inter-VLAN isolation');
  }, 120000);
});
