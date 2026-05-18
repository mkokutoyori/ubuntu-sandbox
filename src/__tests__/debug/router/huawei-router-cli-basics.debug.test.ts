/**
 * Huawei VRP router — CLI basics gap-analysis (~300 steps).
 * View navigation, the full display family, sysname/header/title,
 * pipe filters (| include/exclude/begin), undo negation, user-
 * interface, screen-length, save/reset/reboot, abbreviations, help.
 *
 * Commands are thrown at the router WITHOUT pre-checking what is
 * implemented — the transcript tells us what's missing/wrong.
 */
import { describe, it } from 'vitest';
import {
  buildHuaweiLab, dumpRouter, resetSim, regressionSweep, each,
  type RouterStepInput,
} from './_router-suite';

const DISPLAY = [
  'display version', 'display clock', 'display device', 'display users',
  'display history-command', 'display cpu-usage', 'display memory-usage',
  'display current-configuration', 'display saved-configuration',
  'display this', 'display startup', 'display ip interface brief',
  'display interface', 'display interface brief', 'display ip routing-table',
  'display ip routing-table statistics', 'display ip routing-table protocol direct',
  'display arp', 'display arp all', 'display fib', 'display ip interface',
  'display ospf peer', 'display ospf brief', 'display rip', 'display bgp peer',
  'display acl all', 'display nat session all', 'display ip pool',
  'display dhcp server statistics', 'display vrrp', 'display ike sa',
  'display ipsec sa', 'display snmp-agent sys-info', 'display ntp status',
  'display lldp neighbor', 'display lldp neighbor brief', 'display logbuffer',
  'display trapbuffer', 'display alarm all', 'display elabel',
  'display license', 'display patch-information', 'display ssh server status',
  'display ssh user-information', 'display aaa configuration',
  'display user-interface', 'display port', 'display interface description',
  'display health', 'display temperature all', 'display fan',
  'display power', 'display environment', 'display diagnostic-information',
  'display tcp status', 'display sockets', 'display dns server',
];

const VIEWS: Array<[string, string]> = [
  ['interface GigabitEthernet0/0/0', 'quit'],
  ['interface LoopBack0', 'quit'],
  ['interface Tunnel0/0/0', 'quit'],
  ['ospf 1', 'quit'],
  ['rip 1', 'quit'],
  ['bgp 65000', 'quit'],
  ['isis 1', 'quit'],
  ['acl 2000', 'quit'],
  ['acl name MGMT', 'quit'],
  ['ip pool LAN', 'quit'],
  ['aaa', 'quit'],
  ['user-interface console 0', 'quit'],
  ['user-interface vty 0 4', 'quit'],
  ['route-policy RP permit node 10', 'quit'],
  ['ike proposal 1', 'quit'],
  ['ipsec proposal P1', 'quit'],
];

describe('debug-dump: huawei-router-cli-basics', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildHuaweiLab();
    const steps: RouterStepInput[] = [
      // ── user-view display family ────────────────────────────────
      { section: 'user-view display family', cmd: 'display version' },
      ...each(DISPLAY, (c) => c),
      '?',
      'display ?',
      'ping 10.0.0.2',
      'tracert 10.0.0.2',
      'telnet 10.0.0.2',
      'ssh client 10.0.0.2',
      'system-view',

      // ── system-view + view navigation ───────────────────────────
      { section: 'system-view / view nav', cmd: 'sysname R1-CORE' },
      'header shell information "Authorized only"',
      'header login information "Login banner"',
      ...each(VIEWS, ([enter, leave]) => [enter, 'display this', leave]),
      'info-center enable',
      'undo info-center enable',
      'return',
      'display current-configuration',

      // ── abbreviations ───────────────────────────────────────────
      { section: 'abbreviations', cmd: 'sys' },
      'sysn R1-EDGE',
      'dis th',
      'int g0/0/0',
      'dis th',
      'q',
      'return',
      'dis cu',
      'dis ip int b',
      'dis ip rou',

      // ── context help (?) ────────────────────────────────────────
      { section: 'context help (?)', cmd: 'system-view' },
      ...each(['interface ?', 'ip ?', 'ospf ?', 'undo ?', 'acl ?',
        'aaa ?', 'snmp-agent ?', 'ntp-service ?', 'rip ?', 'bgp ?'],
        (c) => c),
      'interface GigabitEthernet0/0/0',
      'ip ?',
      'ip address ?',
      'quit',
      'return',

      // ── undo / negation ─────────────────────────────────────────
      { section: 'undo / negation', cmd: 'system-view' },
      ...each(['ftp server enable', 'telnet server enable',
        'dhcp enable', 'lldp enable', 'snmp-agent', 'ntp-service enable',
        'ip route-static 1.1.1.0 24 10.0.0.2'],
        (c) => [c, `undo ${c}`]),
      'sysname TEMP',
      'undo sysname',
      'interface GigabitEthernet0/0/0',
      'description WAN-LINK',
      'undo description',
      'shutdown',
      'undo shutdown',
      'quit',
      'return',

      // ── pipe filters ────────────────────────────────────────────
      { section: 'pipe filters', cmd: 'display current-configuration | include ip' },
      'display current-configuration | exclude #',
      'display current-configuration | begin interface',
      'display ip routing-table | include Direct',
      'display ip interface brief | include up',
      'display interface | include line protocol',

      // ── user-interface / screen ─────────────────────────────────
      { section: 'user-interface / screen', cmd: 'screen-length 0 temporary' },
      'screen-length 24 temporary',
      'system-view',
      'user-interface console 0',
      'idle-timeout 0 0',
      'authentication-mode password',
      'set authentication password cipher Huawei@123',
      'quit',
      'user-interface vty 0 4',
      'protocol inbound ssh',
      'authentication-mode aaa',
      'user privilege level 15',
      'idle-timeout 5 0',
      'quit',
      'return',

      // ── save / reset / reboot ───────────────────────────────────
      { section: 'save / reset / reboot', cmd: 'save' },
      'save force',
      'display saved-configuration',
      'reset saved-configuration',
      'compare configuration',
      'startup saved-configuration vrpcfg.zip',
      'reboot fast',
      'reboot',

      ...regressionSweep('huawei'),
    ];
    await dumpRouter('huawei-router-cli-basics', topology, steps,
      'focus=VRP router view nav, display family, pipes, undo, save');
  }, 120000);
});
