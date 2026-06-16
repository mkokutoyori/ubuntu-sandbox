import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-03-trunk-dtp-vtp', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline trunk/VTP state', cmd: 'enable' });
    s.push('show interfaces trunk');
    s.push('show vtp status');
    s.push('show vtp counters');
    s.push('show dtp');
    s.push('show interfaces GigabitEthernet0/1 switchport');

    s.push({ section: 'VTP domain on CORE (server)', on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'configure terminal' });
    s.push({ on: 'core', cmd: 'vtp domain LAB' });
    s.push({ on: 'core', cmd: 'vtp mode server' });
    s.push({ on: 'core', cmd: 'vtp version 2' });
    s.push({ on: 'core', cmd: 'vtp password secret123' });
    s.push({ on: 'core', cmd: 'vtp pruning' });
    s.push({ on: 'core', cmd: 'do show vtp status' });
    s.push({ on: 'core', cmd: 'do show vtp password' });

    s.push({ section: 'VTP clients on SW1 & SW2', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'vtp domain LAB' });
    s.push({ on: 'sw1', cmd: 'vtp mode client' });
    s.push({ on: 'sw1', cmd: 'vtp password secret123' });
    s.push({ on: 'sw1', cmd: 'do show vtp status' });
    s.push({ on: 'sw1', cmd: 'end' });
    s.push({ on: 'sw2', cmd: 'configure terminal' });
    s.push({ on: 'sw2', cmd: 'vtp domain LAB' });
    s.push({ on: 'sw2', cmd: 'vtp mode transparent' });
    s.push({ on: 'sw2', cmd: 'do show vtp status' });
    s.push({ on: 'sw2', cmd: 'end' });

    s.push({ section: 'establish inter-switch trunks', on: 'core', cmd: 'configure terminal' });
    s.push({ on: 'core', cmd: 'interface range GigabitEthernet0/0 - 1' });
    s.push({ on: 'core', cmd: 'switchport trunk encapsulation dot1q' });
    s.push({ on: 'core', cmd: 'switchport mode trunk' });
    s.push({ on: 'core', cmd: 'exit' });
    s.push({ on: 'core', cmd: 'end' });
    s.push({ on: 'core', cmd: 'show interfaces trunk' });
    s.push({ on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface GigabitEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'switchport trunk encapsulation dot1q' });
    s.push({ on: 'sw1', cmd: 'switchport mode trunk' });
    s.push({ on: 'sw1', cmd: 'end' });
    s.push({ on: 'sw1', cmd: 'show interfaces trunk' });
    s.push({ on: 'sw2', cmd: 'configure terminal' });
    s.push({ on: 'sw2', cmd: 'interface GigabitEthernet0/1' });
    s.push({ on: 'sw2', cmd: 'switchport mode trunk' });
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'sw2', cmd: 'show interfaces trunk' });

    s.push({ section: 'VTP VLAN propagation (create on server)', on: 'core', cmd: 'configure terminal' });
    for (let v = 10; v <= 60; v += 10) {
      s.push({ on: 'core', cmd: `vlan ${v}` });
      s.push({ on: 'core', cmd: `name PROP_${v}` });
      s.push({ on: 'core', cmd: 'exit' });
    }
    s.push({ on: 'core', cmd: 'end' });
    s.push({ on: 'core', cmd: 'show vlan brief' });
    s.push({ on: 'sw1', cmd: 'show vlan brief' });
    s.push({ on: 'sw2', cmd: 'show vlan brief' });

    s.push({ section: 'DTP negotiation modes loop (SW1 Fa0/4..0/12)', on: 'sw1', cmd: 'configure terminal' });
    for (let i = 4; i <= 12; i++) {
      s.push({ on: 'sw1', cmd: `interface FastEthernet0/${i}` });
      s.push({ on: 'sw1', cmd: 'switchport mode dynamic auto' });
      s.push({ on: 'sw1', cmd: 'switchport mode dynamic desirable' });
      s.push({ on: 'sw1', cmd: 'switchport nonegotiate' });
      s.push({ on: 'sw1', cmd: 'do show interfaces FastEthernet0/' + i + ' switchport' });
      s.push({ on: 'sw1', cmd: 'exit' });
    }
    s.push({ on: 'sw1', cmd: 'end' });

    s.push({ section: 'trunk allowed-vlan set operations', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface GigabitEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan all' });
    s.push({ on: 'sw1', cmd: 'do show interfaces trunk' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan 10,20,30,40' });
    s.push({ on: 'sw1', cmd: 'do show interfaces trunk' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan add 50,60' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan remove 30' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan except 40' });
    s.push({ on: 'sw1', cmd: 'do show interfaces trunk' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan none' });
    s.push({ on: 'sw1', cmd: 'do show interfaces trunk' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan all' });
    s.push({ on: 'sw1', cmd: 'switchport trunk native vlan 99' });
    s.push({ on: 'sw1', cmd: 'switchport trunk pruning vlan 10,20' });
    s.push({ on: 'sw1', cmd: 'do show interfaces GigabitEthernet0/1 switchport' });
    s.push({ on: 'sw1', cmd: 'end' });

    s.push({ section: 'invalid / edge trunk cases', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'switchport trunk allowed vlan abc' });
    s.push({ on: 'sw1', cmd: 'switchport trunk native vlan 5000' });
    s.push({ on: 'sw1', cmd: 'switchport mode bogus' });
    s.push({ on: 'sw1', cmd: 'switchport trunk encapsulation isl' });
    s.push({ on: 'sw1', cmd: 'end' });

    s.push({ section: 'per-interface trunk/switchport inspection (SW1)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'sw1', cmd: `show interfaces FastEthernet0/${i} switchport` });
    }
    s.push({ on: 'sw1', cmd: 'show interfaces trunk' });
    s.push({ on: 'sw1', cmd: 'show interfaces GigabitEthernet0/1 trunk' });

    s.push({ section: 'connectivity over negotiated trunks', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'switchport access vlan 10' });
    s.push({ on: 'sw1', cmd: 'end' });
    s.push({ on: 'sw2', cmd: 'configure terminal' });
    s.push({ on: 'sw2', cmd: 'vlan 10' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'interface FastEthernet0/1' });
    s.push({ on: 'sw2', cmd: 'switchport access vlan 10' });
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'l1', cmd: 'ping -c 3 192.168.1.21' });
    s.push({ on: 'l2', cmd: 'arp -a' });

    s.push({ section: 'VTP / DTP show family' });
    for (const on of ['core', 'sw1', 'sw2']) {
      s.push({ on, cmd: 'show vtp status' });
      s.push({ on, cmd: 'show vtp counters' });
      s.push({ on, cmd: 'show interfaces trunk' });
      s.push({ on, cmd: 'show vlan brief' });
      s.push({ on, cmd: 'show mac address-table' });
    }

    s.push({ section: 'per-interface switchport inspection (SW2)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'sw2', cmd: `show interfaces FastEthernet0/${i} switchport` });
    }
    s.push({ section: 'per-interface switchport inspection (CORE)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'core', cmd: `show interfaces FastEthernet0/${i} switchport` });
    }
    s.push({ section: 'extended VTP propagation (CORE 70..120)', on: 'core', cmd: 'configure terminal' });
    for (let v = 70; v <= 120; v += 10) {
      s.push({ on: 'core', cmd: `vlan ${v}` });
      s.push({ on: 'core', cmd: `name EXT_${v}` });
      s.push({ on: 'core', cmd: 'exit' });
    }
    s.push({ on: 'core', cmd: 'end' });
    s.push({ on: 'core', cmd: 'show vlan brief' });
    s.push({ on: 'sw1', cmd: 'show vlan brief' });

    s.push({ section: 'host verification' });
    for (const on of ['l1', 'l2', 'srv1', 'srv2']) {
      s.push({ on, cmd: 'ip -br addr' });
      s.push({ on, cmd: 'ip neigh' });
    }
    s.push({ on: 'w1', cmd: 'ipconfig /all' });
    s.push({ on: 'w2', cmd: 'arp -a' });
    s.push({ on: 'sw1', cmd: 'show running-config' });

    s.push({ section: 'extended cross-switch interface inspection appendix' });
    for (const on of ['sw1', 'sw2', 'core']) {
      for (let i = 0; i <= 23; i++) {
        s.push({ on, cmd: `show interfaces FastEthernet0/${i}` });
      }
    }

    await dumpL2('cisco-l2-03-trunk-dtp-vtp', topology, s,
      'focus=trunk encapsulation/allowed-vlan/native, DTP modes, VTP server/client/transparent, propagation');
  }, 180000);
});
