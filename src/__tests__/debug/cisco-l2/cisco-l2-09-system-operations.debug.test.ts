import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

describe('debug-dump: cisco-l2-09-system-operations', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'system identity & inventory', cmd: 'enable' });
    for (const c of [
      'show version', 'show inventory', 'show boot', 'show bootvar',
      'show processes cpu', 'show processes memory', 'show memory statistics',
      'show environment', 'show environment temperature', 'show controllers',
      'show platform', 'show module', 'show redundancy',
    ]) s.push(c);

    s.push({ section: 'flash file system', cmd: 'dir' });
    for (const c of [
      'dir flash:', 'show flash:', 'show file systems', 'pwd',
      'more flash:config.text', 'more nvram:startup-config',
      'verify flash:', 'fsck flash:',
    ]) s.push(c);

    s.push({ section: 'config persistence', cmd: 'configure terminal' });
    s.push('hostname SYS-SW1');
    s.push('vlan 100');
    s.push('name PERSIST');
    s.push('exit');
    s.push('end');
    s.push('show running-config');
    s.push('copy running-config startup-config');
    s.push('write memory');
    s.push('show startup-config');
    s.push('show running-config | include hostname');

    s.push({ section: 'config backup/restore via tftp', cmd: 'copy startup-config tftp:' });
    s.push('copy running-config tftp:');
    s.push('copy tftp: running-config');
    s.push('copy flash:config.text tftp:');

    s.push({ section: 'archive / config replace', cmd: 'configure terminal' });
    s.push('archive');
    s.push('path flash:archive/cfg');
    s.push('maximum 5');
    s.push('write-memory');
    s.push('exit');
    s.push('end');
    s.push('show archive');
    s.push('archive config');

    s.push({ section: 'clock & calendar', cmd: 'clock set 08:30:00 15 June 2026' });
    s.push('show clock');
    s.push('show clock detail');
    s.push('show calendar');
    s.push('configure terminal');
    s.push('clock timezone CET 1');
    s.push('clock summer-time CEST recurring');
    s.push('end');
    s.push('show clock');

    s.push({ section: 'boot system config', cmd: 'configure terminal' });
    s.push('boot system flash:c2960-lanbasek9-mz.150-2.SE.bin');
    s.push('config-register 0x2102');
    s.push('end');
    s.push('show boot');

    s.push({ section: 'per-interface admin reset loop (Fa0/1..0/23)', cmd: 'configure terminal' });
    for (let i = 1; i <= 23; i++) {
      s.push(`interface FastEthernet0/${i}`);
      s.push('shutdown');
      s.push('no shutdown');
      s.push('exit');
    }
    s.push('end');
    s.push('show interfaces status');
    s.push({ section: 'per-interface description + counters loop' });
    for (let i = 1; i <= 23; i++) {
      s.push(`show interfaces FastEthernet0/${i} description`);
    }

    s.push({ section: 'debug controls', cmd: 'debug spanning-tree events' });
    s.push('show debugging');
    s.push('undebug all');
    s.push('debug mac-address-table');
    s.push('no debug all');
    s.push('show debugging');

    s.push({ section: 'pre-reload connectivity', on: 'l1', cmd: 'ping -c 2 192.168.1.13' });
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.21' });
    s.push({ on: 'srv1', cmd: 'ping -c 2 192.168.1.23' });
    s.push({ on: 'sw1', cmd: 'show mac address-table' });

    s.push({ section: 'reload SW1 (host link reactions)', cmd: 'reload in 1' });
    s.push('show reload');
    s.push('reload cancel');
    s.push('show reload');
    s.push('reload');
    s.push({ on: 'l1', cmd: 'ip -br link' });
    s.push({ on: 'srv1', cmd: 'ip -br link' });
    s.push({ on: 'w1', cmd: 'ipconfig' });

    s.push({ section: 'post-reload state', cmd: 'enable' });
    s.push('show version');
    s.push('show running-config');
    s.push('show vlan brief');
    s.push('show mac address-table');
    s.push('show interfaces status');
    s.push({ on: 'l1', cmd: 'ping -c 2 192.168.1.13' });

    s.push({ section: 'erase + reload to factory', cmd: 'erase startup-config' });
    s.push('show startup-config');
    s.push('delete flash:config.text');
    s.push('reload');
    s.push('enable');
    s.push('show running-config');
    s.push('show vlan brief');

    s.push({ section: 'repeated show family across switches' });
    for (const on of ['sw1', 'sw2', 'core']) {
      for (const c of [
        'show version', 'show vlan brief', 'show interfaces status',
        'show mac address-table count', 'show spanning-tree summary',
        'show processes cpu', 'show clock', 'show logging',
      ]) s.push({ on, cmd: on === 'sw1' ? c : c });
    }

    s.push({ section: 'host system inspection' });
    const linuxSys = ['uname -a', 'uptime', 'free -m', 'df -h', 'ps aux', 'systemctl list-units --type=service'];
    const winSys = ['systeminfo', 'tasklist', 'wmic os get caption', 'sc query'];
    for (const c of linuxSys) s.push({ on: 'l1', cmd: c });
    for (const c of linuxSys) s.push({ on: 'srv1', cmd: c });
    for (const c of winSys) s.push({ on: 'w1', cmd: c });
    for (const c of linuxSys) s.push({ on: 'l2', cmd: c });
    for (const c of winSys) s.push({ on: 'w2', cmd: c });
    for (const c of linuxSys) s.push({ on: 'srv2', cmd: c });

    s.push({ section: 'file-system inspection on SW2 & CORE' });
    for (const on of ['sw2', 'core']) {
      for (const c of [
        'dir flash:', 'show flash:', 'show file systems', 'show boot',
        'show version', 'more nvram:startup-config', 'show inventory',
        'show processes memory', 'show redundancy',
      ]) s.push({ on, cmd: c });
    }
    s.push({ section: 'SW2 reload lifecycle', on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'write memory' });
    s.push({ on: 'sw2', cmd: 'reload in 2' });
    s.push({ on: 'sw2', cmd: 'show reload' });
    s.push({ on: 'sw2', cmd: 'reload cancel' });
    s.push({ on: 'sw2', cmd: 'reload' });
    s.push({ on: 'sw2', cmd: 'enable' });
    s.push({ on: 'sw2', cmd: 'show vlan brief' });
    s.push({ on: 'l2', cmd: 'ip -br link' });

    s.push({ section: 'final connectivity check', on: 'l1', cmd: 'ping -c 2 192.168.1.21' });
    s.push({ on: 'srv2', cmd: 'ping -c 2 192.168.1.13' });
    s.push({ on: 'sw1', cmd: 'show mac address-table' });

    await dumpL2('cisco-l2-09-system-operations', topology, s,
      'focus=file system, config persistence/backup, archive, clock, boot, reload/erase lifecycle + host reactions');
  }, 180000);
});
