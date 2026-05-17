/**
 * Cisco IOS STP + L2 security (port-security, DHCP snooping, storm
 * control, ACL, AAA/SSH, SNMP). 68 steps. Gap-analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpCisco, resetSim, type CiscoStepInput } from './_cisco-suite';

describe('debug-dump: cisco-stp-security', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();
    const steps: CiscoStepInput[] = [
      { section: 'STP baseline', cmd: 'show spanning-tree' },
      'enable',
      'show spanning-tree summary',
      'configure terminal',
      'hostname SW-SEC',

      { section: 'STP mode / priority / root', cmd: 'spanning-tree mode rapid-pvst' },
      'spanning-tree mode mst',
      'spanning-tree mode pvst',
      'spanning-tree vlan 10 priority 4096',
      'spanning-tree vlan 10 root primary',
      'spanning-tree vlan 20 root secondary',
      'spanning-tree extend system-id',
      'spanning-tree portfast default',
      'spanning-tree portfast bpduguard default',
      'spanning-tree loopguard default',
      'do show spanning-tree',

      { section: 'MST region', cmd: 'spanning-tree mst configuration' },
      'name LAB',
      'revision 1',
      'instance 1 vlan 10',
      'instance 2 vlan 20',
      'show current',
      'exit',
      'do show spanning-tree mst configuration',

      { section: 'STP per-interface', cmd: 'interface FastEthernet0/1' },
      'spanning-tree portfast',
      'spanning-tree bpduguard enable',
      'spanning-tree bpdufilter enable',
      'spanning-tree cost 19',
      'spanning-tree port-priority 64',
      'spanning-tree guard root',
      'exit',
      'do show spanning-tree interface FastEthernet0/1',

      { section: 'port-security', cmd: 'interface FastEthernet0/2' },
      'switchport mode access',
      'switchport port-security',
      'switchport port-security maximum 3',
      'switchport port-security violation restrict',
      'switchport port-security mac-address sticky',
      'switchport port-security aging time 5',
      'exit',
      'do show port-security',
      'do show port-security interface FastEthernet0/2',

      { section: 'DHCP snooping / DAI / storm', cmd: 'ip dhcp snooping' },
      'ip dhcp snooping vlan 10,20',
      'interface GigabitEthernet0/1',
      'ip dhcp snooping trust',
      'ip arp inspection trust',
      'storm-control broadcast level 10.00',
      'storm-control multicast level 5.00',
      'storm-control action shutdown',
      'exit',
      'ip arp inspection vlan 10',
      'do show ip dhcp snooping',

      { section: 'ACL', cmd: 'access-list 10 permit 10.0.0.0 0.0.0.255' },
      'ip access-list extended BLOCK',
      'permit ip 192.168.10.0 0.0.0.255 any',
      'deny ip any any',
      'exit',
      'do show access-lists',

      { section: 'AAA / SSH / SNMP', cmd: 'username admin privilege 15 secret cisco' },
      'enable secret cisco',
      'aaa new-model',
      'ip domain-name lab.local',
      'crypto key generate rsa modulus 2048',
      'line vty 0 4',
      'transport input ssh',
      'login local',
      'exit',
      'snmp-server community public RO',
      'ntp server 10.0.0.1',
      'logging host 10.0.0.251',
      'end',
      'show running-config',
    ];
    await dumpCisco('cisco-stp-security', topology, steps,
      'focus=STP/MST, port-security, DHCP snooping, ACL, AAA/SSH, SNMP',
      { resyncSwitchPerSection: true });
  });
});
