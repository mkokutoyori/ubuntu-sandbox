import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-02-vlan-access', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline VLAN database', cmd: 'enable' });
    s.push('show vlan brief');
    s.push('show vlan');
    s.push('show vlan summary');
    s.push('configure terminal');

    s.push({ section: 'VLAN creation loop (10..200)' });
    for (let v = 10; v <= 200; v += 10) {
      s.push(`vlan ${v}`);
      s.push(`name VLAN_${v}`);
      s.push('exit');
    }
    s.push('do show vlan brief');

    s.push({ section: 'VLAN ranges & lists' });
    s.push('vlan 300-305');
    s.push('vlan 400,410,420');
    s.push('vlan 999');
    s.push('name MGMT');
    s.push('exit');
    s.push('do show vlan brief');
    s.push('vlan 0');
    s.push('vlan 4096');
    s.push('vlan abc');

    s.push({ section: 'SW1 access port assignment loop (Fa0/1..0/23)' });
    for (let i = 1; i <= 23; i++) {
      const v = 10 + ((i % 5) * 10);
      s.push(`interface FastEthernet0/${i}`);
      s.push('switchport mode access');
      s.push(`switchport access vlan ${v}`);
      s.push('exit');
    }
    s.push('do show vlan brief');
    s.push('do show interfaces status');

    s.push({ section: 'inter-switch trunks (carry all VLANs)', cmd: 'interface GigabitEthernet0/1' });
    s.push('switchport trunk encapsulation dot1q');
    s.push('switchport mode trunk');
    s.push('switchport trunk allowed vlan all');
    s.push('exit');
    s.push('end');
    s.push({ on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'configure terminal' });
    s.push({ on: 'sw2', cmd: 'vlan 10' });
    s.push({ on: 'sw2', cmd: 'name VLAN_10' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'vlan 20' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'interface FastEthernet0/1' });
    s.push({ on: 'sw2', cmd: 'switchport mode access' });
    s.push({ on: 'sw2', cmd: 'switchport access vlan 10' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'interface FastEthernet0/2' });
    s.push({ on: 'sw2', cmd: 'switchport mode access' });
    s.push({ on: 'sw2', cmd: 'switchport access vlan 20' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'interface GigabitEthernet0/1' });
    s.push({ on: 'sw2', cmd: 'switchport mode trunk' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'configure terminal' });
    s.push({ on: 'core', cmd: 'vlan 10,20' });
    s.push({ on: 'core', cmd: 'exit' });
    s.push({ on: 'core', cmd: 'interface range GigabitEthernet0/0 - 1' });
    s.push({ on: 'core', cmd: 'switchport mode trunk' });
    s.push({ on: 'core', cmd: 'exit' });
    s.push({ on: 'core', cmd: 'end' });
    s.push({ on: 'core', cmd: 'show interfaces trunk' });

    s.push({ section: 'put L1 & L2 in VLAN 10 (same broadcast domain across trunk)', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'switchport access vlan 10' });
    s.push({ on: 'sw1', cmd: 'exit' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/2' });
    s.push({ on: 'sw1', cmd: 'switchport access vlan 20' });
    s.push({ on: 'sw1', cmd: 'end' });

    s.push({ section: 'connectivity: same VLAN across switches', on: 'l1', cmd: 'ping -c 3 192.168.1.21' });
    s.push({ on: 'l1', cmd: 'arp -a' });
    s.push({ on: 'l2', cmd: 'ping -c 3 192.168.1.11' });
    s.push({ on: 'sw1', cmd: 'show mac address-table vlan 10' });
    s.push({ on: 'sw2', cmd: 'show mac address-table vlan 10' });
    s.push({ on: 'core', cmd: 'show mac address-table' });

    s.push({ section: 'connectivity: different VLAN, same switch (must fail)', on: 'l1', cmd: 'ping -c 1 192.168.1.12' });
    s.push({ on: 'w1', cmd: 'ping -n 1 192.168.1.11' });

    s.push({ section: 'connectivity: different VLAN across switches (must fail)', on: 'l1', cmd: 'ping -c 1 192.168.1.22' });
    s.push({ on: 'w2', cmd: 'ping -n 1 192.168.1.11' });

    s.push({ section: 'move W2 into VLAN 10 to restore reachability', on: 'sw2', cmd: 'configure terminal' });
    s.push({ on: 'sw2', cmd: 'interface FastEthernet0/2' });
    s.push({ on: 'sw2', cmd: 'switchport access vlan 10' });
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'w2', cmd: 'ping -n 1 192.168.1.11' });
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.22' });

    s.push({ section: 'voice VLAN', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'vlan 50' });
    s.push({ on: 'sw1', cmd: 'name VOICE' });
    s.push({ on: 'sw1', cmd: 'exit' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/2' });
    s.push({ on: 'sw1', cmd: 'switchport voice vlan 50' });
    s.push({ on: 'sw1', cmd: 'do show interfaces FastEthernet0/2 switchport' });
    s.push({ on: 'sw1', cmd: 'end' });

    s.push({ section: 'per-interface switchport inspection loop (SW1)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'sw1', cmd: `show interfaces FastEthernet0/${i} switchport` });
    }

    s.push({ section: 'VLAN deletion & cleanup', on: 'sw1', cmd: 'configure terminal' });
    for (let v = 110; v <= 200; v += 10) {
      s.push({ on: 'sw1', cmd: `no vlan ${v}` });
    }
    s.push({ on: 'sw1', cmd: 'do show vlan brief' });
    s.push({ on: 'sw1', cmd: 'end' });

    s.push({ section: 'final host verification' });
    for (const on of ['l1', 'l2', 'srv1', 'srv2']) {
      s.push({ on, cmd: 'ip -br addr' });
      s.push({ on, cmd: 'arp -a' });
    }
    s.push({ on: 'w1', cmd: 'ipconfig' });
    s.push({ on: 'w2', cmd: 'arp -a' });
    s.push({ on: 'sw1', cmd: 'show vlan brief' });
    s.push({ on: 'sw1', cmd: 'show mac address-table' });
    s.push({ on: 'sw1', cmd: 'show running-config' });

    s.push({ section: 'extended cross-switch interface inspection appendix' });
    for (const on of ['sw1', 'sw2', 'core']) {
      for (let i = 0; i <= 23; i++) {
        s.push({ on, cmd: `show interfaces FastEthernet0/${i}` });
      }
    }

    await dumpL2('cisco-l2-02-vlan-access', topology, s,
      'focus=VLAN lifecycle/ranges, access ports, inter-switch trunks, VLAN isolation, voice VLAN');
  }, 180000);
});
