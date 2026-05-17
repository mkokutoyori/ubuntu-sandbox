/**
 * Huawei VRP security & management plane — STP/RSTP/MSTP, edge/BPDU
 * protection, port-security sticky MAC, DHCP snooping, ACLs, AAA local
 * users, SSH/Telnet/STelnet, SNMP, NTP, syslog, sFlow, save/backup.
 *
 * 72 steps. Transcript dump for gap analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpHuawei, resetSim, type HuaweiStepInput } from './_huawei-suite';

describe('debug-dump: huawei-security-mgmt', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();

    const steps: HuaweiStepInput[] = [
      { section: 'STP baseline', cmd: 'display stp' },
      'display stp brief',
      'system-view',
      'sysname SW-SEC',

      { section: 'STP / RSTP / MSTP', cmd: 'stp mode rstp' },
      'stp enable',
      'stp priority 4096',
      'stp root primary',
      'stp mode mstp',
      'stp region-configuration',
      'region-name LAB',
      'instance 1 vlan 10',
      'instance 2 vlan 20',
      'active region-configuration',
      'quit',
      'interface GigabitEthernet0/0/1',
      'stp edged-port enable',
      'stp bpdu-protection',
      'quit',
      'stp bpdu-protection',
      'interface GigabitEthernet0/0/23',
      'stp cost 20000',
      'stp port priority 64',
      'quit',
      'return',
      'display stp',
      'display stp interface GigabitEthernet0/0/1',

      { section: 'port-security sticky MAC', cmd: 'system-view' },
      'interface GigabitEthernet0/0/2',
      'port-security enable',
      'port-security mac-address sticky',
      'port-security max-mac-num 2',
      'port-security protect-action shutdown',
      'quit',
      'return',
      'display port-security',

      { section: 'DHCP snooping / IPSG / DAI', cmd: 'system-view' },
      'dhcp enable',
      'dhcp snooping enable',
      'interface GigabitEthernet0/0/1',
      'dhcp snooping enable',
      'dhcp snooping trusted',
      'ip source check user-bind enable',
      'arp anti-attack check user-bind enable',
      'quit',
      'return',
      'display dhcp snooping',

      { section: 'ACL', cmd: 'system-view' },
      'acl 3001',
      'rule 5 permit ip source 192.168.10.0 0.0.0.255 destination 192.168.20.0 0.0.0.255',
      'rule 10 deny ip',
      'quit',
      'acl name MGMT 2999',
      'rule permit source 10.0.0.0 0.0.0.255',
      'quit',
      'return',
      'display acl all',
      'display acl 3001',

      { section: 'AAA local users + SSH/Telnet', cmd: 'system-view' },
      'aaa',
      'local-user admin password irreversible-cipher Huawei@123',
      'local-user admin privilege level 15',
      'local-user admin service-type ssh telnet terminal',
      'quit',
      'stelnet server enable',
      'ssh user admin authentication-type password',
      'user-interface vty 0 4',
      'authentication-mode aaa',
      'protocol inbound ssh',
      'quit',
      'telnet server enable',
      'return',
      'display ssh server status',
      'display local-user',

      { section: 'SNMP / NTP / syslog / sFlow', cmd: 'system-view' },
      'snmp-agent sys-info version v2c v3',
      'snmp-agent community read cipher public',
      'snmp-agent target-host trap address udp-domain 10.0.0.250 params securityname public',
      'ntp-service unicast-server 10.0.0.1',
      'clock timezone UTC add 00:00',
      'info-center enable',
      'info-center loghost 10.0.0.251',
      'sflow collector 1 ip 10.0.0.252',
      'return',
      'display snmp-agent sys-info',
      'display ntp-service status',

      { section: 'save / backup', cmd: 'save' },
      'display saved-configuration',
      'display current-configuration | include snmp',
      'reset saved-configuration',
    ];

    await dumpHuawei(
      'huawei-security-mgmt',
      topology,
      steps,
      'focus=STP/MSTP, port-security, DHCP snooping, ACL, AAA/SSH, SNMP/NTP',
    );
  });
});
