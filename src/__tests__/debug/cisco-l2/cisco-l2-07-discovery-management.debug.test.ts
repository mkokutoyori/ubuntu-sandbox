import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-07-discovery-management', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline discovery/management', cmd: 'enable' });
    for (const c of [
      'show cdp', 'show cdp neighbors', 'show cdp neighbors detail',
      'show lldp', 'show lldp neighbors', 'show clock', 'show ntp status',
      'show ntp associations', 'show snmp', 'show logging', 'show ip interface brief',
    ]) s.push(c);

    s.push({ section: 'CDP global + per-interface loop', cmd: 'configure terminal' });
    s.push('cdp run');
    s.push('cdp timer 30');
    s.push('cdp holdtime 120');
    s.push('cdp advertise-v2');
    for (let i = 1; i <= 12; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('cdp enable');
      s.push('exit');
    }
    s.push('end');
    s.push('show cdp neighbors');
    s.push('show cdp neighbors detail');
    s.push('show cdp interface');
    s.push('show cdp traffic');

    s.push({ section: 'LLDP global + per-interface loop', cmd: 'configure terminal' });
    s.push('lldp run');
    s.push('lldp timer 30');
    s.push('lldp holdtime 120');
    s.push('lldp reinit 2');
    for (let i = 1; i <= 12; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('lldp transmit');
      s.push('lldp receive');
      s.push('exit');
    }
    s.push('end');
    s.push('show lldp neighbors');
    s.push('show lldp neighbors detail');
    s.push('show lldp interface');
    s.push('show lldp traffic');

    s.push({ section: 'management SVI (Vlan1) + default gateway', cmd: 'configure terminal' });
    s.push('interface Vlan1');
    s.push('ip address 192.168.1.254 255.255.255.0');
    s.push('no shutdown');
    s.push('exit');
    s.push('ip default-gateway 192.168.1.1');
    s.push('do show ip interface brief');
    s.push('do show interfaces Vlan1');
    s.push('end');
    s.push('show running-config interface Vlan1');

    s.push({ section: 'hostname & banners', cmd: 'configure terminal' });
    s.push('hostname ACCESS-SW1');
    s.push('banner motd #Unauthorized access prohibited#');
    s.push('banner login #Login banner#');
    s.push('banner exec #Welcome#');
    s.push('hostname SW1');
    s.push('end');

    s.push({ section: 'local users & privilege loop', cmd: 'configure terminal' });
    s.push('enable secret Str0ngEnable!');
    s.push('enable password Weak');
    s.push('service password-encryption');
    for (let i = 1; i <= 6; i++) {
      s.push(`username user${i} privilege ${i <= 3 ? 1 : 15} secret Pass${i}!`);
    }
    s.push('username admin privilege 15 secret AdminPass!');
    s.push('do show running-config | include username');
    s.push('end');

    s.push({ section: 'AAA + line vty login', cmd: 'configure terminal' });
    s.push('aaa new-model');
    s.push('aaa authentication login default local');
    s.push('aaa authorization exec default local');
    s.push('line vty 0 15');
    s.push('login authentication default');
    s.push('exec-timeout 10 0');
    s.push('exit');
    s.push('line console 0');
    s.push('login local');
    s.push('logging synchronous');
    s.push('exit');
    s.push('end');

    s.push({ section: 'SSH server enablement', cmd: 'configure terminal' });
    s.push('ip domain-name lab.local');
    s.push('crypto key generate rsa modulus 2048');
    s.push('ip ssh version 2');
    s.push('ip ssh time-out 60');
    s.push('ip ssh authentication-retries 3');
    s.push('line vty 0 15');
    s.push('transport input ssh');
    s.push('exit');
    s.push('do show ip ssh');
    s.push('do show ssh');
    s.push('end');

    s.push({ section: 'logging config + hosts loop', cmd: 'configure terminal' });
    s.push('logging on');
    s.push('logging buffered 16384 debugging');
    s.push('logging console warnings');
    s.push('logging trap informational');
    s.push('logging facility local6');
    for (const ip of ['192.168.1.13', '192.168.1.23', '10.0.0.50']) {
      s.push(`logging host ${ip}`);
    }
    s.push('logging source-interface Vlan1');
    s.push('service timestamps log datetime msec');
    s.push('do show logging');
    s.push('end');

    s.push({ section: 'clock + NTP/SNTP', cmd: 'clock set 12:00:00 15 June 2026' });
    s.push('configure terminal');
    s.push('clock timezone UTC 0');
    s.push('ntp server 192.168.1.13');
    s.push('ntp server 192.168.1.23 prefer');
    s.push('ntp authenticate');
    s.push('ntp authentication-key 1 md5 NtpKey');
    s.push('ntp trusted-key 1');
    s.push('sntp server 192.168.1.13');
    s.push('do show ntp associations');
    s.push('do show ntp status');
    s.push('do show clock');
    s.push('end');

    s.push({ section: 'SNMP', cmd: 'configure terminal' });
    s.push('snmp-server community public RO');
    s.push('snmp-server community private RW');
    s.push('snmp-server location LAB-RACK-1');
    s.push('snmp-server contact netops@lab.local');
    s.push('snmp-server host 192.168.1.13 version 2c public');
    s.push('snmp-server enable traps');
    s.push('do show snmp');
    s.push('do show snmp community');
    s.push('end');

    s.push({ section: 'CORE & SW2 discovery', on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'show cdp neighbors' });
    s.push({ on: 'core', cmd: 'show lldp neighbors' });
    s.push({ on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'show cdp neighbors' });
    s.push({ on: 'sw2', cmd: 'show lldp neighbors' });

    s.push({ section: 'management reachability from hosts', on: 'l1', cmd: 'ping -c 2 192.168.1.254' });
    s.push({ on: 'srv1', cmd: 'ping -c 2 192.168.1.254' });
    s.push({ on: 'l1', cmd: 'arp -a' });

    s.push({ section: 'per-interface discovery inspection loop' });
    for (let i = 1; i <= 23; i++) {
      s.push(`show cdp interface FastEthernet0/${i}`);
      s.push(`show lldp interface FastEthernet0/${i}`);
    }

    s.push({ section: 'SW2 management plane', on: 'sw2', cmd: 'configure terminal' });
    s.push({ on: 'sw2', cmd: 'interface Vlan1' });
    s.push({ on: 'sw2', cmd: 'ip address 192.168.1.253 255.255.255.0' });
    s.push({ on: 'sw2', cmd: 'no shutdown' });
    s.push({ on: 'sw2', cmd: 'exit' });
    s.push({ on: 'sw2', cmd: 'ip default-gateway 192.168.1.1' });
    s.push({ on: 'sw2', cmd: 'enable secret Sw2Enable!' });
    s.push({ on: 'sw2', cmd: 'ip domain-name lab.local' });
    s.push({ on: 'sw2', cmd: 'crypto key generate rsa modulus 2048' });
    s.push({ on: 'sw2', cmd: 'ip ssh version 2' });
    s.push({ on: 'sw2', cmd: 'logging host 192.168.1.13' });
    s.push({ on: 'sw2', cmd: 'ntp server 192.168.1.23' });
    s.push({ on: 'sw2', cmd: 'snmp-server community public RO' });
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'sw2', cmd: 'show ip interface brief' });
    s.push({ on: 'sw2', cmd: 'show ip ssh' });
    s.push({ on: 'sw2', cmd: 'show logging' });
    s.push({ on: 'sw2', cmd: 'show ntp associations' });
    s.push({ on: 'sw2', cmd: 'show running-config' });
    s.push({ on: 'l2', cmd: 'ping -c 2 192.168.1.253' });

    s.push({ section: 'host service inspection (SRV1/SRV2)' });
    for (const on of ['srv1', 'srv2']) {
      s.push({ on, cmd: 'ss -tlnp' });
      s.push({ on, cmd: 'systemctl status sshd' });
      s.push({ on, cmd: 'systemctl status chronyd' });
      s.push({ on, cmd: 'cat /etc/ntp.conf' });
    }
    s.push({ on: 'sw1', cmd: 'show running-config' });

    s.push({ section: 'extended cross-switch interface inspection appendix' });
    for (const on of ['sw1', 'sw2', 'core']) {
      for (let i = 0; i <= 23; i++) {
        s.push({ on, cmd: `show interfaces FastEthernet0/${i}` });
      }
    }

    await dumpL2('cisco-l2-07-discovery-management', topology, s,
      'focus=CDP/LLDP, management SVI, users/AAA, SSH, logging, NTP/SNTP, SNMP');
  }, 180000);
});
