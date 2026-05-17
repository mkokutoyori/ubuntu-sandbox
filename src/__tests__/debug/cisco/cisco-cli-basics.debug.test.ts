/**
 * Cisco IOS CLI basics — mode nav, hostname, show family, do-prefix,
 * pipe filters, history, banner, save/reload. 64 steps. Gap-analysis.
 */
import { describe, it } from 'vitest';
import { buildLab, dumpCisco, resetSim, type CiscoStepInput } from './_cisco-suite';

describe('debug-dump: cisco-cli-basics', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildLab();
    const steps: CiscoStepInput[] = [
      { section: 'user / show', cmd: 'show version' },
      'show clock',
      'show users',
      'show history',
      'show inventory',
      'show processes cpu',
      'show memory statistics',
      'show running-config',
      'show startup-config',

      { section: 'enable / mode nav', cmd: 'enable' },
      'show privilege',
      'configure terminal',
      'hostname SW-CORE',
      'do show clock',
      'interface FastEthernet0/1',
      'do show running-config',
      'exit',
      'vlan 10',
      'exit',
      'line console 0',
      'exit',
      'end',
      'show running-config',

      { section: 'abbreviations', cmd: 'en' },
      'conf t',
      'host SW-EDGE',
      'do sh ver',
      'end',
      'sh run',
      'sh ip int br',

      { section: 'context help (?)', cmd: 'show ?' },
      '?',
      'configure terminal',
      'interface ?',
      'spanning-tree ?',
      'no ?',
      'end',

      { section: 'no / negation', cmd: 'configure terminal' },
      'hostname TEMP',
      'no hostname',
      'ip domain-lookup',
      'no ip domain-lookup',
      'interface FastEthernet0/5',
      'description test',
      'no description',
      'shutdown',
      'no shutdown',
      'exit',
      'end',

      { section: 'pipe filters', cmd: 'show running-config | include vlan' },
      'show running-config | begin interface',
      'show running-config | exclude !',
      'show ip interface brief | include up',
      'terminal length 0',

      { section: 'banner / save / reload', cmd: 'configure terminal' },
      'banner motd # Authorized access only #',
      'end',
      'write memory',
      'copy running-config startup-config',
      'show flash',
      'reload',
    ];
    await dumpCisco('cisco-cli-basics', topology, steps,
      'focus=IOS user/priv/config nav, show family, do-prefix, pipes');
  });
});
