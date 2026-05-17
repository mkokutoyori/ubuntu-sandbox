/**
 * Cisco IOS router — CLI basics gap-analysis (~300 steps).
 * Mode navigation, the full show family, hostname/banner/domain,
 * pipe filters, history, abbreviations, context-help (?), no-negation,
 * terminal settings, aliases, privilege levels, save/reload/copy.
 *
 * Commands are thrown at the router WITHOUT pre-checking what is
 * implemented — the transcript is what tells us what's missing.
 */
import { describe, it } from 'vitest';
import {
  buildCiscoLab, dumpRouter, resetSim, regressionSweep, each, type RouterStepInput,
} from './_router-suite';

const SHOW = [
  'show version', 'show clock', 'show calendar', 'show users', 'show history',
  'show inventory', 'show processes cpu', 'show processes cpu history',
  'show processes memory', 'show memory statistics', 'show memory summary',
  'show running-config', 'show startup-config', 'show running-config all',
  'show ip interface brief', 'show interfaces', 'show interfaces description',
  'show interfaces status', 'show interfaces summary', 'show ip interface',
  'show ip route', 'show ip route summary', 'show ip route connected',
  'show ip protocols', 'show ip arp', 'show arp', 'show mac address-table',
  'show cdp neighbors', 'show cdp neighbors detail', 'show cdp interface',
  'show lldp neighbors', 'show lldp neighbors detail',
  'show ip dhcp binding', 'show ip dhcp pool', 'show ip dhcp server statistics',
  'show ip nat translations', 'show ip nat statistics',
  'show access-lists', 'show ip access-lists',
  'show logging', 'show snmp', 'show ntp status', 'show ntp associations',
  'show flash', 'show file systems', 'show controllers', 'show environment',
  'show platform', 'show license', 'show license udi', 'show boot',
  'show redundancy', 'show buffers', 'show stacks', 'show reload',
  'show tcp brief', 'show sockets', 'show vrf', 'show hosts',
  'show ip ssh', 'show ssh', 'show line', 'show terminal',
  'show privilege', 'show aaa sessions', 'show ip vrf',
  'show tech-support', 'show diag', 'show idprom backplane',
];

const SUBMODES: Array<[string, string]> = [
  ['interface GigabitEthernet0/0', 'exit'],
  ['interface Loopback0', 'exit'],
  ['interface Tunnel0', 'exit'],
  ['router ospf 1', 'exit'],
  ['router rip', 'exit'],
  ['router eigrp 100', 'exit'],
  ['router bgp 65000', 'exit'],
  ['ip dhcp pool LAN', 'exit'],
  ['line console 0', 'exit'],
  ['line vty 0 4', 'exit'],
  ['line aux 0', 'exit'],
  ['ip access-list standard STD1', 'exit'],
  ['ip access-list extended EXT1', 'exit'],
  ['route-map RM1 permit 10', 'exit'],
  ['class-map CM1', 'exit'],
  ['policy-map PM1', 'exit'],
  ['crypto isakmp policy 10', 'exit'],
  ['crypto ipsec transform-set TS1 esp-aes esp-sha-hmac', 'exit'],
  ['crypto map CM 10 ipsec-isakmp', 'exit'],
  ['key chain KC1', 'exit'],
  ['track 1 interface GigabitEthernet0/0 line-protocol', 'exit'],
  ['vrf definition CUST', 'exit'],
];

describe('debug-dump: cisco-router-cli-basics', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildCiscoLab();
    const steps: RouterStepInput[] = [
      // ── user-mode show family ───────────────────────────────────
      { section: 'user-mode show family', cmd: 'show version' },
      ...each(SHOW, (c) => c),
      '?',
      'show ?',
      'ping',
      'traceroute',
      'telnet 10.0.0.2',
      'ssh -l admin 10.0.0.2',
      'enable',

      // ── privileged-mode show family ─────────────────────────────
      { section: 'privileged show family', cmd: 'show privilege' },
      ...each(SHOW, (c) => c),
      'show controllers GigabitEthernet0/0',
      'show interfaces GigabitEthernet0/0',
      'show interfaces GigabitEthernet0/0 stats',
      'show interfaces accounting',
      'debug ip packet',
      'undebug all',
      'show debugging',

      // ── enter/exit every config sub-mode ───────────────────────
      { section: 'config sub-mode navigation', cmd: 'configure terminal' },
      ...each(SUBMODES, ([enter, leave]) => [enter, 'do show clock', leave]),
      'end',

      // ── hostname / domain / banner ──────────────────────────────
      { section: 'hostname / domain / banner', cmd: 'configure terminal' },
      'hostname R1-CORE',
      'ip domain-name lab.local',
      'ip domain-lookup',
      'no ip domain-lookup',
      'ip name-server 8.8.8.8',
      'ip name-server 8.8.4.4 1.1.1.1',
      'banner motd # Authorized access only #',
      'banner login ^C Login banner ^C',
      'banner exec $ Exec banner $',
      'clock timezone UTC 0',
      'clock summer-time CEST recurring',
      'no banner motd',
      'end',
      'show running-config | include banner',

      // ── abbreviations ──────────────────────────────────────────
      { section: 'abbreviations', cmd: 'en' },
      'conf t',
      'host R1-EDGE',
      'do sh ver',
      'do sh ip int br',
      'int gi0/0',
      'ip addr 192.168.1.1 255.255.255.0',
      'no shut',
      'do sh run int gi0/0',
      'exi',
      'rou ospf 1',
      'net 192.168.1.0 0.0.0.255 a 0',
      'end',
      'sh ip int br',
      'sh ip ro',
      'wr',

      // ── context help (?) sweep ─────────────────────────────────
      { section: 'context help (?)', cmd: 'configure terminal' },
      ...each(
        ['interface ?', 'ip ?', 'router ?', 'no ?', 'crypto ?', 'access-list ?',
         'snmp-server ?', 'logging ?', 'ntp ?', 'clock ?', 'banner ?',
         'aaa ?', 'username ?', 'line ?', 'service ?', 'spanning-tree ?'],
        (c) => c),
      'interface GigabitEthernet0/0',
      'ip ?',
      'ip address ?',
      'ip ospf ?',
      'standby ?',
      'exit',
      'end',

      // ── no / negation battery ──────────────────────────────────
      { section: 'no / negation battery', cmd: 'configure terminal' },
      ...each(
        ['logging buffered', 'service timestamps', 'service password-encryption',
         'ip cef', 'ip routing', 'ip domain-lookup', 'cdp run',
         'lldp run', 'ip http server', 'ip http secure-server',
         'ip source-route', 'ip bootp server', 'ip finger',
         'service config', 'service pad', 'ip gratuitous-arps'],
        (c) => [c, `no ${c}`]),
      'end',

      // ── pipe filters ───────────────────────────────────────────
      { section: 'pipe filters', cmd: 'show running-config | include hostname' },
      'show running-config | exclude !',
      'show running-config | begin interface',
      'show running-config | section interface',
      'show running-config | section router',
      'show ip interface brief | include up',
      'show ip interface brief | exclude unassigned',
      'show ip route | include C',
      'show ip route | begin Gateway',
      'show interfaces | include line protocol',
      'show processes cpu | exclude 0.00',
      'show running-config | redirect flash:cfg.txt',
      'show running-config | append flash:cfg.txt',
      'show running-config | tee flash:cfg.txt',

      // ── terminal / line settings ───────────────────────────────
      { section: 'terminal settings', cmd: 'terminal length 0' },
      'terminal length 24',
      'terminal width 132',
      'terminal monitor',
      'terminal no monitor',
      'terminal history size 100',
      'terminal exec prompt timestamp',
      'configure terminal',
      'line console 0',
      'exec-timeout 0 0',
      'logging synchronous',
      'history size 50',
      'privilege level 15',
      'exit',
      'line vty 0 4',
      'transport input ssh',
      'transport input telnet ssh',
      'transport output none',
      'access-class 10 in',
      'exec-timeout 5 0',
      'login local',
      'exit',
      'end',

      // ── aliases / privilege ────────────────────────────────────
      { section: 'aliases / privilege', cmd: 'configure terminal' },
      'alias exec sr show running-config',
      'alias exec sib show ip interface brief',
      'privilege exec level 5 show running-config',
      'enable secret cisco123',
      'enable password weakpass',
      'username admin privilege 15 secret admin123',
      'username operator privilege 5 password oper',
      'service password-encryption',
      'end',
      'sr',
      'sib',
      'show aliases',

      // ── save / reload / copy ───────────────────────────────────
      { section: 'save / reload / copy', cmd: 'write memory' },
      'copy running-config startup-config',
      'copy startup-config running-config',
      'copy running-config tftp:',
      'copy running-config flash:backup.cfg',
      'write erase',
      'erase startup-config',
      'show startup-config',
      'reload in 5',
      'reload cancel',
      'reload',
      ...regressionSweep('cisco'),
    ];
    await dumpRouter('cisco-router-cli-basics', topology, steps,
      'focus=IOS router CLI: show family, mode nav, pipes, no, save');
  }, 120000);
});
