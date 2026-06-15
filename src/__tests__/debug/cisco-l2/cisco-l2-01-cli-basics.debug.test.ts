import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-01-cli-basics', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'user EXEC help & prompt', cmd: '?' });
    s.push('show ?');
    s.push('s?');
    s.push('sh?');
    s.push('en?');
    s.push('enable ?');
    s.push('ping ?');
    s.push('terminal ?');
    s.push('show version');
    s.push('show clock');
    s.push('show users');
    s.push('show history');
    s.push('show terminal');
    s.push('where');
    s.push('show sessions');
    s.push('show interfaces status');

    s.push({ section: 'enter privileged EXEC', cmd: 'enable' });
    s.push('?');
    s.push('show ?');
    s.push('configure ?');
    s.push('clear ?');
    s.push('debug ?');
    s.push('write ?');
    s.push('copy ?');
    s.push('reload ?');

    s.push({ section: 'privileged show family', cmd: 'show running-config' });
    for (const c of [
      'show startup-config', 'show version', 'show inventory', 'show flash:',
      'show vlan', 'show vlan brief', 'show vlan id 1',
      'show mac address-table', 'show mac address-table count',
      'show mac address-table dynamic', 'show mac address-table static',
      'show spanning-tree', 'show spanning-tree summary', 'show spanning-tree root',
      'show interfaces', 'show interfaces status', 'show interfaces trunk',
      'show interfaces counters', 'show interfaces description',
      'show ip interface brief', 'show cdp neighbors', 'show cdp neighbors detail',
      'show lldp neighbors', 'show etherchannel summary', 'show vtp status',
      'show port-security', 'show errdisable recovery', 'show clock',
      'show processes cpu', 'show processes memory', 'show environment',
      'show controllers', 'show logging', 'show boot', 'show users',
      'show privilege', 'show ip arp', 'show arp',
    ]) s.push(c);

    s.push({ section: 'terminal session settings', cmd: 'terminal length 0' });
    s.push('terminal length 24');
    s.push('terminal width 80');
    s.push('terminal width 132');
    s.push('terminal monitor');
    s.push('terminal no monitor');
    s.push('terminal history size 50');
    s.push('show terminal');

    s.push({ section: 'global config navigation', cmd: 'configure terminal' });
    s.push('?');
    s.push('hostname SW1-EDGE');
    s.push('do show running-config');
    s.push('no hostname');
    s.push('hostname SW1');
    s.push('banner motd # Authorized access only #');
    s.push('do show running-config | include banner');
    s.push('exit');

    s.push({ section: 'interface sub-mode navigation', cmd: 'configure terminal' });
    s.push('interface FastEthernet0/1');
    s.push('?');
    s.push('description LINK-TO-L1');
    s.push('do show running-config interface FastEthernet0/1');
    s.push('exit');
    s.push('interface range FastEthernet0/4 - 8');
    s.push('description UNUSED-RANGE');
    s.push('shutdown');
    s.push('exit');
    s.push('end');

    s.push({ section: 'line config navigation', cmd: 'configure terminal' });
    s.push('line console 0');
    s.push('?');
    s.push('exec-timeout 5 0');
    s.push('logging synchronous');
    s.push('exit');
    s.push('line vty 0 15');
    s.push('exec-timeout 10 0');
    s.push('transport input ssh');
    s.push('login local');
    s.push('exit');
    s.push('end');

    s.push({ section: 'abbreviations & partials', cmd: 'sh ver' });
    s.push('sh run');
    s.push('sh vl br');
    s.push('sh int status');
    s.push('sh mac add');
    s.push('conf t');
    s.push('int fa0/1');
    s.push('do sh run int fa0/1');
    s.push('end');
    s.push('wr');

    s.push({ section: 'invalid input handling', cmd: 'shww version' });
    s.push('show versionnn');
    s.push('frobnicate');
    s.push('show');
    s.push('configure');
    s.push('interface');

    s.push({ section: 'per-interface inspection loop' });
    for (let i = 1; i <= 23; i++) {
      s.push(`show interfaces FastEthernet0/${i}`);
      s.push(`show interfaces FastEthernet0/${i} switchport`);
    }
    s.push('show interfaces GigabitEthernet0/0');
    s.push('show interfaces GigabitEthernet0/1');
    s.push('show interfaces GigabitEthernet0/0 switchport');
    s.push('show interfaces GigabitEthernet0/1 switchport');

    s.push({ section: 'CORE & SW2 prompts', on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'show version' });
    s.push({ on: 'core', cmd: 'show vlan brief' });
    s.push({ on: 'core', cmd: 'show interfaces trunk' });
    s.push({ on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'show version' });
    s.push({ on: 'sw2', cmd: 'show mac address-table' });
    s.push({ on: 'sw2', cmd: 'show interfaces status' });

    s.push({ section: 'host inspection — L1 (Linux)', on: 'l1', cmd: 'uname -a' });
    for (const c of ['hostname', 'ip addr show eth0', 'ifconfig eth0', 'ip route', 'arp -a', 'cat /etc/hostname']) {
      s.push({ on: 'l1', cmd: c });
    }
    s.push({ section: 'host inspection — W1 (Windows)', on: 'w1', cmd: 'ipconfig' });
    for (const c of ['ipconfig /all', 'hostname', 'arp -a', 'route print', 'getmac']) {
      s.push({ on: 'w1', cmd: c });
    }
    s.push({ section: 'host inspection — SRV1 (Linux server)', on: 'srv1', cmd: 'uname -a' });
    for (const c of ['ip addr show eth0', 'ip -br link', 'ss -tlnp', 'systemctl status sshd', 'arp -n']) {
      s.push({ on: 'srv1', cmd: c });
    }
    s.push({ section: 'host inspection — L2/W2/SRV2', on: 'l2', cmd: 'ip addr show eth0' });
    s.push({ on: 'w2', cmd: 'ipconfig' });
    s.push({ on: 'srv2', cmd: 'ip addr show eth0' });

    s.push({ section: 'per-interface counters & cdp loop' });
    for (let i = 1; i <= 23; i++) {
      s.push(`show interfaces FastEthernet0/${i} counters`);
      s.push(`show cdp interface FastEthernet0/${i}`);
    }

    s.push({ section: 'broad host inspection across all six machines' });
    const linuxCmds = ['hostname', 'whoami', 'ip -br addr', 'ip neigh', 'cat /etc/resolv.conf', 'netstat -rn', 'uptime'];
    const winCmds = ['hostname', 'whoami', 'ipconfig /all', 'arp -a', 'netstat -rn', 'systeminfo'];
    for (const c of linuxCmds) s.push({ on: 'l1', cmd: c });
    for (const c of winCmds) s.push({ on: 'w1', cmd: c });
    for (const c of linuxCmds) s.push({ on: 'srv1', cmd: c });
    for (const c of linuxCmds) s.push({ on: 'l2', cmd: c });
    for (const c of winCmds) s.push({ on: 'w2', cmd: c });
    for (const c of linuxCmds) s.push({ on: 'srv2', cmd: c });

    s.push({ section: 'connectivity smoke test', on: 'l1', cmd: 'ping -c 2 192.168.1.12' });
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.21' });
    s.push({ on: 'l1', cmd: 'arp -a' });
    s.push('show mac address-table');

    s.push({ section: 'extended cross-switch interface inspection appendix' });
    for (const on of ['sw1', 'sw2', 'core']) {
      for (let i = 0; i <= 23; i++) {
        s.push({ on, cmd: `show interfaces FastEthernet0/${i}` });
      }
    }

    await dumpL2('cisco-l2-01-cli-basics', topology, s,
      'focus=CLI parsing, help, prompts, mode navigation, show family, host inspection');
  });
});
