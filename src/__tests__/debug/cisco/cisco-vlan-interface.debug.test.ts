/**
 * Cisco IOS VLAN + switchport (L2-only). 66 steps. Gap-analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpCisco, resetSim, type CiscoStepInput } from './_cisco-suite';

describe('debug-dump: cisco-vlan-interface', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();
    const steps: CiscoStepInput[] = [
      { section: 'baseline', cmd: 'show vlan brief' },
      'enable',
      'show vlan',
      'configure terminal',
      'hostname SW-VLAN',

      { section: 'VLAN lifecycle', cmd: 'vlan 10' },
      'name SALES',
      'exit',
      'vlan 20',
      'name ENG',
      'exit',
      'do show vlan brief',
      'no vlan 20',
      'do show vlan brief',
      'vlan 100,200,300',
      'vlan 30-35',
      'do show vlan brief',

      { section: 'access ports', cmd: 'interface FastEthernet0/1' },
      'switchport mode access',
      'switchport access vlan 10',
      'do show running-config interface FastEthernet0/1',
      'exit',
      'interface range FastEthernet0/3 - 8',
      'switchport mode access',
      'switchport access vlan 10',
      'exit',

      { section: 'trunk ports', cmd: 'interface GigabitEthernet0/1' },
      'switchport trunk encapsulation dot1q',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10,20,100',
      'switchport trunk allowed vlan add 200',
      'switchport trunk native vlan 99',
      'switchport nonegotiate',
      'do show interfaces trunk',
      'exit',

      { section: 'voice / portfast / port-security', cmd: 'interface FastEthernet0/2' },
      'switchport mode access',
      'switchport access vlan 10',
      'switchport voice vlan 50',
      'spanning-tree portfast',
      'switchport port-security',
      'switchport port-security maximum 2',
      'switchport port-security violation shutdown',
      'switchport port-security mac-address sticky',
      'exit',

      { section: 'etherchannel', cmd: 'interface range FastEthernet0/21 - 22' },
      'channel-group 1 mode active',
      'exit',
      'interface Port-channel1',
      'switchport mode trunk',
      'exit',
      'do show etherchannel summary',

      { section: 'L3 on L2 switch (expect rejected)', cmd: 'interface Vlan10' },
      'ip address 192.168.10.1 255.255.255.0',
      'exit',
      'ip routing',
      'do show ip route',
      'end',

      { section: 'inspection', cmd: 'show vlan' },
      'show interfaces status',
      'show interfaces FastEthernet0/1 switchport',
      'show mac address-table',
      'show mac address-table vlan 10',
      'show running-config',
    ];
    await dumpCisco('cisco-vlan-interface', topology, steps,
      'focus=L2 VLAN lifecycle, access/trunk, voice, port-security, etherchannel',
      { resyncSwitchPerSection: true });
  });
});
