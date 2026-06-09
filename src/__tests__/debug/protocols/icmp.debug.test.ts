import { describe, it, expect } from 'vitest';
import {
  buildEnterpriseWAN, initializeWAN, resetSim, dumpProtocol,
  each, SITE, WAN, type ProtoStepInput,
} from './_enterprise-wan';

const cR = ['rhq', 'rdc'] as const;
const lH = ['lhq', 'lbr', 'ldc', 'srvdc'] as const;
const wH = ['whq', 'wbr'] as const;
const allH = [...lH, ...wH] as const;

const isWin = (h: string) => h === 'whq' || h === 'wbr';
const png = (h: string, ip: string, n = 2) => (isWin(h) ? `ping -n ${n} ${ip}` : `ping -c ${n} ${ip}`);
const trc = (h: string, ip: string) => (isWin(h) ? `tracert -d -h 8 ${ip}` : `traceroute -n -m 8 ${ip}`);

const SELF: Record<string, string> = {
  lhq: SITE.hq.linux, whq: SITE.hq.win,
  wbr: SITE.br.win, lbr: SITE.br.linux,
  srvdc: SITE.dc.srv, ldc: SITE.dc.linux,
};
const GW: Record<string, string> = {
  lhq: SITE.hq.gw, whq: SITE.hq.gw,
  wbr: SITE.br.gw, lbr: SITE.br.gw,
  srvdc: SITE.dc.gw, ldc: SITE.dc.gw,
};

const GATEWAYS = [SITE.hq.gw, SITE.br.gw, SITE.dc.gw];
const REMOTE_HOSTS = [SITE.hq.linux, SITE.hq.win, SITE.br.win, SITE.br.linux, SITE.dc.srv, SITE.dc.linux];
const WAN_IPS = [WAN.hqbr.hq, WAN.hqbr.br, WAN.hqdc.hq, WAN.hqdc.dc, WAN.brdc.dc, WAN.brdc.br];

function buildSteps(): ProtoStepInput[] {
  return [
    { section: 'ICMP — activation logs & debug (Cisco)', on: 'rhq', cmd: 'enable' },
    ...each(cR, (r) => ([
      { on: r, cmd: 'terminal monitor' },
      { on: r, cmd: 'debug ip icmp' },
      { on: r, cmd: 'show debugging' },
      { on: r, cmd: 'show logging' },
    ] as ProtoStepInput[])),

    { section: 'ICMP — activation logs & debug (Huawei)', on: 'rbr', cmd: 'terminal monitor' },
    { on: 'rbr', cmd: 'terminal debugging' },
    { on: 'rbr', cmd: 'debugging ip icmp' },
    { on: 'rbr', cmd: 'display debugging' },
    { on: 'rbr', cmd: 'display logbuffer' },

    { section: 'ICMP — sysctl & capture (Linux)', on: 'lhq', cmd: 'tcpdump -c 3 -i eth0 icmp' },
    ...each(lH, (h) => ([
      { on: h, cmd: 'sysctl net.ipv4.icmp_echo_ignore_all' },
      { on: h, cmd: 'sysctl net.ipv4.icmp_echo_ignore_broadcasts' },
      { on: h, cmd: 'sysctl net.ipv4.icmp_ratelimit' },
    ] as ProtoStepInput[])),

    { section: 'ICMP — joignabilité passerelle locale', on: 'lhq', cmd: png('lhq', SITE.hq.gw) },
    ...each(allH, (h) => ({ on: h, cmd: png(h, GW[h]) } as ProtoStepInput)),

    { section: 'ICMP — boucle locale & auto-ping', on: 'lhq', cmd: png('lhq', '127.0.0.1') },
    ...each(allH, (h) => ([
      { on: h, cmd: png(h, '127.0.0.1', 1) },
      { on: h, cmd: png(h, SELF[h], 1) },
    ] as ProtoStepInput[])),

    { section: 'ICMP — matrice inter-sites (toutes passerelles)', on: 'lhq', cmd: png('lhq', SITE.br.gw) },
    ...each(allH, (h) => each(GATEWAYS, (g) => ({ on: h, cmd: png(h, g, 1) } as ProtoStepInput))),

    { section: 'ICMP — matrice inter-sites (tous hôtes distants)', on: 'lhq', cmd: png('lhq', SITE.dc.srv) },
    ...each(allH, (h) => each(REMOTE_HOSTS.filter((ip) => ip !== SELF[h]), (t) => ({ on: h, cmd: png(h, t, 1) } as ProtoStepInput))),

    { section: 'ICMP — joignabilité des liens WAN depuis les hôtes', on: 'lhq', cmd: png('lhq', WAN.hqbr.hq, 1) },
    ...each(allH, (h) => each(WAN_IPS, (ip) => ({ on: h, cmd: png(h, ip, 1) } as ProtoStepInput))),

    { section: 'ICMP — pings originés par les routeurs', on: 'rhq', cmd: `ping ${WAN.hqbr.br}` },
    ...each(WAN_IPS, (ip) => ({ on: 'rhq', cmd: `ping ${ip}` } as ProtoStepInput)),
    ...each([SITE.br.gw, SITE.dc.gw, SITE.br.win, SITE.dc.srv], (ip) => ({ on: 'rhq', cmd: `ping ${ip}` } as ProtoStepInput)),
    ...each([WAN.hqdc.hq, SITE.hq.gw, SITE.br.gw, SITE.hq.linux], (ip) => ({ on: 'rdc', cmd: `ping ${ip}` } as ProtoStepInput)),
    { on: 'rbr', cmd: `ping ${SITE.hq.gw}` },
    { on: 'rbr', cmd: `ping ${SITE.dc.gw}` },
    { on: 'rbr', cmd: `ping ${SITE.hq.linux}` },
    { on: 'rbr', cmd: `ping -c 5 ${SITE.dc.srv}` },

    { section: 'ICMP — TTL & traceroute', on: 'lhq', cmd: trc('lhq', SITE.dc.srv) },
    { on: 'lhq', cmd: trc('lhq', SITE.br.win) },
    { on: 'ldc', cmd: trc('ldc', SITE.hq.linux) },
    { on: 'lbr', cmd: trc('lbr', SITE.dc.linux) },
    { on: 'whq', cmd: trc('whq', SITE.dc.srv) },
    { on: 'wbr', cmd: trc('wbr', SITE.hq.win) },
    { on: 'rhq', cmd: `traceroute ${SITE.br.linux}` },
    { on: 'rbr', cmd: `tracert ${SITE.dc.linux}` },
    { on: 'lhq', cmd: 'ping -c 1 -t 1 10.3.3.10' },
    { on: 'lhq', cmd: 'ping -c 1 -t 2 10.3.3.10' },
    { on: 'whq', cmd: 'ping -n 1 -i 1 10.3.3.10' },
    { on: 'rhq', cmd: 'ping 10.3.3.10 ttl 1' },

    { section: 'ICMP — taille, fragmentation & bit DF', on: 'lhq', cmd: 'ping -c 2 -s 1000 10.3.3.10' },
    { on: 'lhq', cmd: 'ping -c 2 -s 1472 10.2.2.10' },
    { on: 'lhq', cmd: 'ping -c 1 -s 2000 10.3.3.10' },
    { on: 'lhq', cmd: 'ping -c 1 -M do -s 1500 10.3.3.10' },
    { on: 'lhq', cmd: 'ping -c 1 -M do -s 100 10.3.3.10' },
    { on: 'srvdc', cmd: 'ping -c 1 -M dont -s 2000 10.1.1.10' },
    { on: 'whq', cmd: 'ping -n 1 -l 1000 10.2.2.10' },
    { on: 'whq', cmd: 'ping -n 1 -f -l 1500 10.3.3.10' },
    { on: 'rhq', cmd: 'ping 10.3.3.10 size 1500' },
    { on: 'rhq', cmd: 'ping 10.3.3.10 size 1500 df-bit' },
    { on: 'rbr', cmd: 'ping -s 1500 10.1.1.10' },

    { section: 'ICMP — destination unreachable (hôte/réseau)', on: 'lhq', cmd: png('lhq', '10.1.1.200', 1) },
    ...each(allH, (h) => ({ on: h, cmd: png(h, '198.51.100.7', 1) } as ProtoStepInput)),
    { on: 'lhq', cmd: png('lhq', '10.3.3.250', 1) },
    { on: 'rhq', cmd: 'ping 203.0.113.9' },
    { on: 'rhq', cmd: 'ping 10.99.99.99' },
    { on: 'rbr', cmd: 'ping 203.0.113.9' },
    { on: 'ldc', cmd: png('ldc', '10.2.2.222', 1) },

    { section: 'sécurité — politique pare-feu hôte (iptables) bloque ICMP', on: 'srvdc', cmd: 'iptables -L -n' },
    { on: 'srvdc', cmd: 'iptables -A INPUT -p icmp --icmp-type echo-request -j DROP' },
    { on: 'srvdc', cmd: 'iptables -L INPUT -n -v' },
    { on: 'ldc', cmd: png('ldc', SITE.dc.srv, 2) },
    { on: 'lhq', cmd: png('lhq', SITE.dc.srv, 2) },
    { on: 'srvdc', cmd: 'iptables -A INPUT -p icmp -j ACCEPT' },
    { on: 'srvdc', cmd: 'iptables -D INPUT -p icmp --icmp-type echo-request -j DROP' },
    { on: 'srvdc', cmd: 'iptables -F' },
    { on: 'srvdc', cmd: 'iptables -L -n' },
    { on: 'ldc', cmd: png('ldc', SITE.dc.srv, 2) },

    { section: 'sécurité — ACL Cisco filtre ICMP entrant (R-DC WAN)', on: 'rdc', cmd: 'configure terminal' },
    { on: 'rdc', cmd: 'ip access-list extended WAN-IN' },
    { on: 'rdc', cmd: 'deny icmp any any echo' },
    { on: 'rdc', cmd: 'permit ip any any' },
    { on: 'rdc', cmd: 'exit' },
    { on: 'rdc', cmd: 'interface GigabitEthernet0/1' },
    { on: 'rdc', cmd: 'ip access-group WAN-IN in' },
    { on: 'rdc', cmd: 'end' },
    { on: 'rdc', cmd: 'show ip access-lists WAN-IN' },
    { on: 'lhq', cmd: png('lhq', SITE.dc.srv, 2) },
    { on: 'lhq', cmd: png('lhq', SITE.dc.gw, 2) },
    { on: 'rdc', cmd: 'show ip access-lists WAN-IN' },
    { on: 'rdc', cmd: 'configure terminal' },
    { on: 'rdc', cmd: 'interface GigabitEthernet0/1' },
    { on: 'rdc', cmd: 'no ip access-group WAN-IN in' },
    { on: 'rdc', cmd: 'exit' },
    { on: 'rdc', cmd: 'no ip access-list extended WAN-IN' },
    { on: 'rdc', cmd: 'end' },
    { on: 'lhq', cmd: png('lhq', SITE.dc.srv, 2) },

    { section: 'sécurité — Huawei traffic-filter ICMP', on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'acl number 3001' },
    { on: 'rbr', cmd: 'rule 5 deny icmp source 10.1.1.0 0.0.0.255' },
    { on: 'rbr', cmd: 'rule 10 permit ip' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'interface GigabitEthernet0/0/1' },
    { on: 'rbr', cmd: 'traffic-filter inbound acl 3001' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'lhq', cmd: png('lhq', SITE.br.win, 2) },
    { on: 'rbr', cmd: 'display acl 3001' },
    { on: 'rbr', cmd: 'interface GigabitEthernet0/0/1' },
    { on: 'rbr', cmd: 'undo traffic-filter inbound acl 3001' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'undo acl number 3001' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'lhq', cmd: png('lhq', SITE.br.win, 2) },

    { section: 'ICMP — ignorer les echo (sysctl Linux)', on: 'srvdc', cmd: 'sysctl -w net.ipv4.icmp_echo_ignore_all=1' },
    { on: 'srvdc', cmd: 'sysctl net.ipv4.icmp_echo_ignore_all' },
    { on: 'ldc', cmd: png('ldc', SITE.dc.srv, 2) },
    { on: 'lhq', cmd: png('lhq', SITE.dc.srv, 2) },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.icmp_echo_ignore_all=0' },
    { on: 'ldc', cmd: png('ldc', SITE.dc.srv, 2) },

    { section: 'ICMP — unreachables & redirects (routeurs)', on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'no ip unreachables' },
    { on: 'rhq', cmd: 'no ip redirects' },
    { on: 'rhq', cmd: 'do show ip interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'ip unreachables' },
    { on: 'rhq', cmd: 'ip redirects' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'interface GigabitEthernet0/0/0' },
    { on: 'rbr', cmd: 'undo icmp-redirect send' },
    { on: 'rbr', cmd: 'display this' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'quit' },

    { section: 'ICMP — compteurs & statistiques', on: 'rhq', cmd: 'show ip traffic' },
    { on: 'rdc', cmd: 'show ip traffic' },
    { on: 'rbr', cmd: 'display icmp statistics' },
    { on: 'rbr', cmd: 'display ip statistics' },
    ...each(lH, (h) => ([
      { on: h, cmd: 'cat /proc/net/snmp | grep -A1 Icmp' },
      { on: h, cmd: 'netstat -s | head -30' },
    ] as ProtoStepInput[])),
    { on: 'whq', cmd: 'netsh interface ipv4 show icmpstats' },

    { section: 'ICMP — rate-limit / rafale', on: 'lhq', cmd: 'ping -c 5 -i 0.2 10.3.3.10' },
    { on: 'lhq', cmd: 'ping -f -c 20 10.1.1.1' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.icmp_ratelimit=100' },
    { on: 'srvdc', cmd: 'sysctl net.ipv4.icmp_ratelimit' },
    { on: 'ldc', cmd: 'ping -c 10 -i 0.2 10.3.3.10' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.icmp_ratelimit=1000' },
    { on: 'whq', cmd: 'ping -n 4 10.2.2.10' },

    { section: 'ICMP — cas négatifs / mal formés', on: 'lhq', cmd: 'ping' },
    { on: 'lhq', cmd: 'ping -c abc 10.1.1.1' },
    { on: 'lhq', cmd: 'ping 999.1.1.1' },
    { on: 'lhq', cmd: 'ping -c 1 hote.inexistant.invalid' },
    { on: 'whq', cmd: 'ping' },
    { on: 'whq', cmd: 'ping -n -1 10.1.1.1' },
    { on: 'rhq', cmd: 'ping' },
    { on: 'rhq', cmd: 'ping 10.1.1.999' },
    { on: 'rbr', cmd: 'ping' },
    { on: 'rbr', cmd: 'traceroute' },

    { section: 'ICMP — désactivation debug & état final', on: 'rhq', cmd: 'undebug all' },
    { on: 'rdc', cmd: 'undebug all' },
    { on: 'rbr', cmd: 'undo debugging all' },
    { on: 'rhq', cmd: `ping ${SITE.dc.srv}` },
    ...each(allH, (h) => ({ on: h, cmd: png(h, GW[h], 1) } as ProtoStepInput)),
    { on: 'rhq', cmd: 'show ip route' },
    { on: 'rbr', cmd: 'display ip routing-table' },
    { on: 'rhq', cmd: 'show logging' },
    { on: 'rbr', cmd: 'display logbuffer' },
    ...each(lH, (h) => ({ on: h, cmd: 'ip -s neigh' } as ProtoStepInput)),
  ];
}

describe('debug — protocol ICMP (RFC 792) across the enterprise WAN', () => {
  it('exercises echo/reachability, TTL/traceroute, MTU/DF, unreachable and security filtering across vendors', async () => {
    resetSim();
    const wan = buildEnterpriseWAN();
    await initializeWAN(wan);

    const steps = buildSteps();
    expect(steps.length).toBeGreaterThanOrEqual(300);

    await dumpProtocol(
      'icmp',
      wan.topology,
      steps,
      'protocol=ICMP (RFC 792) — focus: echo/joignabilité, TTL/traceroute, MTU/DF, ' +
      'destination unreachable, filtrage (iptables/ACL/traffic-filter), compteurs — ' +
      'multi-vendor (Cisco/Huawei/Linux/Windows/generic)',
    );
  }, 300000);
});
