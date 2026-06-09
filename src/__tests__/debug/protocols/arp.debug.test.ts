import { describe, it, expect } from 'vitest';
import {
  buildEnterpriseWAN, initializeWAN, resetSim, dumpProtocol,
  each, SITE, type ProtoStepInput,
} from './_enterprise-wan';

const cR = ['rhq', 'rdc'] as const;
const lH = ['lhq', 'lbr', 'ldc', 'srvdc'] as const;
const wH = ['whq', 'wbr'] as const;

const NEIGH: Record<string, { ip: string; gw: string; peer: string; peerName: string }> = {
  lhq: { ip: SITE.hq.linux, gw: SITE.hq.gw, peer: SITE.hq.win, peerName: 'PC-HQ-W' },
  whq: { ip: SITE.hq.win, gw: SITE.hq.gw, peer: SITE.hq.linux, peerName: 'PC-HQ-L' },
  wbr: { ip: SITE.br.win, gw: SITE.br.gw, peer: SITE.br.linux, peerName: 'PC-BR-L' },
  lbr: { ip: SITE.br.linux, gw: SITE.br.gw, peer: SITE.br.win, peerName: 'PC-BR-W' },
  srvdc: { ip: SITE.dc.srv, gw: SITE.dc.gw, peer: SITE.dc.linux, peerName: 'PC-DC-L' },
  ldc: { ip: SITE.dc.linux, gw: SITE.dc.gw, peer: SITE.dc.srv, peerName: 'SRV-DC' },
};

const FAKE_MAC = '02:00:00:de:ad:01';

function buildSteps(): ProtoStepInput[] {
  return [
    { section: 'ARP — activation logs & debug (Cisco)', on: 'rhq', cmd: 'enable' },
    ...each(cR, (r) => ([
      { on: r, cmd: 'terminal monitor' },
      { on: r, cmd: 'debug arp' },
      { on: r, cmd: 'show debugging' },
      { on: r, cmd: 'show logging' },
    ] as ProtoStepInput[])),
    ...each(['swhq'], (s) => ([
      { on: s, cmd: 'enable' },
      { on: s, cmd: 'terminal monitor' },
      { on: s, cmd: 'debug arp' },
      { on: s, cmd: 'show logging' },
    ] as ProtoStepInput[])),

    { section: 'ARP — activation logs & debug (Huawei)', on: 'rbr', cmd: 'terminal monitor' },
    { on: 'rbr', cmd: 'terminal debugging' },
    { on: 'rbr', cmd: 'debugging arp packet' },
    { on: 'rbr', cmd: 'display debugging' },
    { on: 'rbr', cmd: 'display logbuffer' },
    { on: 'swbr', cmd: 'terminal monitor' },
    { on: 'swbr', cmd: 'display logbuffer' },

    { section: 'ARP — capture & sysctl ARP (Linux/Windows)', on: 'lhq', cmd: 'tcpdump -c 2 -i eth0 arp' },
    ...each(lH, (h) => ([
      { on: h, cmd: 'sysctl net.ipv4.conf.all.arp_ignore' },
      { on: h, cmd: 'sysctl net.ipv4.conf.all.arp_announce' },
      { on: h, cmd: 'sysctl net.ipv4.neigh.default.gc_stale_time' },
      { on: h, cmd: 'ip link show eth0' },
    ] as ProtoStepInput[])),
    ...each(wH, (h) => ([
      { on: h, cmd: 'getmac' },
      { on: h, cmd: 'ipconfig /all' },
    ] as ProtoStepInput[])),

    { section: 'ARP — tables initiales (routeurs Cisco)', on: 'rhq', cmd: 'show ip arp' },
    ...each(cR, (r) => ([
      { on: r, cmd: 'show ip arp' },
      { on: r, cmd: 'show arp' },
      { on: r, cmd: 'show arp summary' },
      { on: r, cmd: 'show ip arp GigabitEthernet0/0' },
    ] as ProtoStepInput[])),

    { section: 'ARP — tables initiales (Huawei)', on: 'rbr', cmd: 'display arp' },
    { on: 'rbr', cmd: 'display arp all' },
    { on: 'rbr', cmd: 'display arp dynamic' },
    { on: 'rbr', cmd: 'display arp static' },
    { on: 'rbr', cmd: 'display arp interface GigabitEthernet0/0/0' },
    { on: 'rbr', cmd: 'display arp statistics all' },

    { section: 'ARP — tables initiales (switchs)', on: 'swhq', cmd: 'show mac address-table' },
    { on: 'swhq', cmd: 'show mac address-table dynamic' },
    { on: 'swhq', cmd: 'show mac address-table count' },
    { on: 'swbr', cmd: 'display mac-address' },
    { on: 'swbr', cmd: 'display mac-address dynamic' },
    { on: 'swbr', cmd: 'display mac-address summary' },
    { on: 'swdc', cmd: 'show mac address-table' },

    { section: 'ARP — tables initiales (hôtes)', on: 'lhq', cmd: 'arp -n' },
    ...each(lH, (h) => ([
      { on: h, cmd: 'arp -n' },
      { on: h, cmd: 'arp -a' },
      { on: h, cmd: 'ip neigh show' },
      { on: h, cmd: 'cat /proc/net/arp' },
    ] as ProtoStepInput[])),
    ...each(wH, (h) => ([
      { on: h, cmd: 'arp -a' },
      { on: h, cmd: 'arp -g' },
      { on: h, cmd: 'netsh interface ip show neighbors' },
    ] as ProtoStepInput[])),

    { section: 'ARP — résolution déclenchée intra-LAN (clear → ping → show)', on: 'lhq', cmd: 'ip neigh flush dev eth0' },
    ...each(lH, (h) => {
      const n = NEIGH[h];
      return [
        { on: h, cmd: 'ip neigh flush dev eth0' },
        { on: h, cmd: 'arp -n' },
        { on: h, cmd: `ping -c 1 ${n.peer}` },
        { on: h, cmd: `arp -n ${n.peer}` },
        { on: h, cmd: 'ip neigh show' },
        { on: h, cmd: `ip neigh show ${n.peer} dev eth0` },
      ] as ProtoStepInput[];
    }),
    ...each(wH, (h) => {
      const n = NEIGH[h];
      return [
        { on: h, cmd: 'arp -d *' },
        { on: h, cmd: `ping -n 1 ${n.peer}` },
        { on: h, cmd: 'arp -a' },
      ] as ProtoStepInput[];
    }),

    { section: 'ARP — résolution de la passerelle (inter-LAN)', on: 'lhq', cmd: 'ip neigh flush dev eth0' },
    ...each(lH, (h) => {
      const n = NEIGH[h];
      return [
        { on: h, cmd: 'ip neigh flush dev eth0' },
        { on: h, cmd: `ping -c 1 ${n.gw}` },
        { on: h, cmd: `ip neigh show ${n.gw} dev eth0` },
        { on: h, cmd: `arp -n ${n.gw}` },
      ] as ProtoStepInput[];
    }),

    { section: 'ARP — caches routeurs après trafic', on: 'rhq', cmd: 'show ip arp' },
    { on: 'rdc', cmd: 'show ip arp' },
    { on: 'rbr', cmd: 'display arp all' },
    { on: 'rhq', cmd: 'show ip arp 10.1.1.10' },
    { on: 'rhq', cmd: 'show ip arp 10.1.1.11' },
    { on: 'rbr', cmd: 'display arp | include 10.2.2' },

    { section: 'ARP statique — Linux (set → show → del)', on: 'lhq', cmd: `arp -s 10.1.1.250 ${FAKE_MAC}` },
    ...each(lH, (h) => ([
      { on: h, cmd: `arp -s 10.255.255.${1} ${FAKE_MAC}` },
      { on: h, cmd: 'arp -n' },
      { on: h, cmd: `ip neigh add 10.255.255.2 lladdr ${FAKE_MAC} dev eth0 nud permanent` },
      { on: h, cmd: 'ip neigh show nud permanent' },
      { on: h, cmd: `ip neigh replace 10.255.255.2 lladdr 02:00:00:de:ad:02 dev eth0 nud permanent` },
      { on: h, cmd: 'ip neigh show 10.255.255.2 dev eth0' },
      { on: h, cmd: 'arp -d 10.255.255.1' },
      { on: h, cmd: 'ip neigh del 10.255.255.2 dev eth0' },
      { on: h, cmd: 'ip neigh show' },
    ] as ProtoStepInput[])),
    ...each(wH, (h) => ([
      { on: h, cmd: `arp -s 10.0.0.250 ${FAKE_MAC}` },
      { on: h, cmd: 'arp -a' },
      { on: h, cmd: 'arp -d 10.0.0.250' },
    ] as ProtoStepInput[])),

    { section: 'ARP statique — Cisco (set → show → del)', on: 'rhq', cmd: 'configure terminal' },
    ...each(cR, (r) => ([
      { on: r, cmd: 'configure terminal' },
      { on: r, cmd: `arp 10.9.9.9 ${FAKE_MAC.replace(/:/g, '').replace(/(.{4})(.{4})(.{4})/, '$1.$2.$3')} arpa` },
      { on: r, cmd: 'end' },
      { on: r, cmd: 'show ip arp 10.9.9.9' },
      { on: r, cmd: 'show ip arp | include Static' },
      { on: r, cmd: 'configure terminal' },
      { on: r, cmd: 'no arp 10.9.9.9' },
      { on: r, cmd: 'end' },
    ] as ProtoStepInput[])),

    { section: 'ARP statique — Huawei (set → show → del)', on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'arp static 10.9.9.9 00e0-fc12-3456' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'display arp static' },
    { on: 'rbr', cmd: 'display arp | include 10.9.9.9' },
    { on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'undo arp static 10.9.9.9' },
    { on: 'rbr', cmd: 'quit' },

    { section: 'Proxy ARP — Cisco', on: 'rhq', cmd: 'show ip interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'ip proxy-arp' },
    { on: 'rhq', cmd: 'do show ip interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'no ip proxy-arp' },
    { on: 'rhq', cmd: 'do show ip interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'end' },

    { section: 'Proxy ARP — Huawei', on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'interface GigabitEthernet0/0/0' },
    { on: 'rbr', cmd: 'arp-proxy enable' },
    { on: 'rbr', cmd: 'display this' },
    { on: 'rbr', cmd: 'undo arp-proxy enable' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'quit' },

    { section: 'Proxy ARP — Linux (sysctl)', on: 'srvdc', cmd: 'sysctl net.ipv4.conf.all.proxy_arp' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.proxy_arp=1' },
    { on: 'srvdc', cmd: 'sysctl net.ipv4.conf.all.proxy_arp' },
    { on: 'srvdc', cmd: 'cat /proc/sys/net/ipv4/conf/eth0/proxy_arp' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.proxy_arp=0' },

    { section: 'Gratuitous ARP & détection de doublon (Linux)', on: 'lhq', cmd: 'arping -c 2 -U -I eth0 10.1.1.10' },
    ...each(lH, (h) => {
      const n = NEIGH[h];
      return [
        { on: h, cmd: `arping -c 2 -A -I eth0 ${n.ip}` },
        { on: h, cmd: `arping -c 2 -U -I eth0 ${n.ip}` },
        { on: h, cmd: `arping -c 1 -D -I eth0 ${n.peer}` },
        { on: h, cmd: `arping -c 2 -I eth0 ${n.gw}` },
      ] as ProtoStepInput[];
    }),

    { section: 'ARP — réglage du timeout / expire-time', on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'arp timeout 600' },
    { on: 'rhq', cmd: 'do show ip arp' },
    { on: 'rhq', cmd: 'arp timeout 14400' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'interface GigabitEthernet0/0/0' },
    { on: 'rbr', cmd: 'arp expire-time 600' },
    { on: 'rbr', cmd: 'display this' },
    { on: 'rbr', cmd: 'undo arp expire-time' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'quit' },

    { section: 'Linux — durcissement ARP (arp_ignore/announce/filter)', on: 'srvdc', cmd: 'sysctl net.ipv4.conf.all.arp_ignore' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.arp_ignore=1' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.arp_announce=2' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.arp_filter=1' },
    { on: 'srvdc', cmd: 'sysctl -a 2>/dev/null | grep arp' },
    { on: 'ldc', cmd: `ping -c 2 ${SITE.dc.srv}` },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.arp_ignore=0' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.arp_announce=0' },
    { on: 'srvdc', cmd: 'sysctl -w net.ipv4.conf.all.arp_filter=0' },
    { on: 'ldc', cmd: `ping -c 2 ${SITE.dc.srv}` },

    { section: 'L2 — corrélation MAC/ARP sur switchs', on: 'swhq', cmd: 'show mac address-table dynamic' },
    { on: 'swhq', cmd: 'show mac address-table interface FastEthernet0/2' },
    { on: 'swhq', cmd: 'show mac address-table address 02:00:00:00:00:4b' },
    { on: 'swhq', cmd: 'show mac address-table aging-time' },
    { on: 'swbr', cmd: 'display mac-address dynamic' },
    { on: 'swbr', cmd: 'display mac-address aging-time' },
    { on: 'swdc', cmd: 'show mac address-table' },

    { section: 'Dynamic ARP Inspection (DAI) — tentatives', on: 'swhq', cmd: 'show ip arp inspection' },
    { on: 'swhq', cmd: 'configure terminal' },
    { on: 'swhq', cmd: 'ip arp inspection vlan 1' },
    { on: 'swhq', cmd: 'do show ip arp inspection vlan 1' },
    { on: 'swhq', cmd: 'no ip arp inspection vlan 1' },
    { on: 'swhq', cmd: 'end' },

    { section: 'ARP — vidage des caches (clear/reset/flush)', on: 'rhq', cmd: 'clear ip arp' },
    { on: 'rdc', cmd: 'clear arp-cache' },
    { on: 'rbr', cmd: 'reset arp dynamic' },
    { on: 'rbr', cmd: 'reset arp interface GigabitEthernet0/0/0' },
    ...each(lH, (h) => ([
      { on: h, cmd: 'ip neigh flush all' },
      { on: h, cmd: 'arp -n' },
    ] as ProtoStepInput[])),
    ...each(wH, (h) => ([
      { on: h, cmd: 'arp -d *' },
      { on: h, cmd: 'arp -a' },
    ] as ProtoStepInput[])),

    { section: 'ARP — re-résolution complète après flush', on: 'lhq', cmd: `ping -c 1 ${SITE.hq.gw}` },
    ...each(lH, (h) => {
      const n = NEIGH[h];
      return [
        { on: h, cmd: `ping -c 1 ${n.gw}` },
        { on: h, cmd: `ping -c 1 ${n.peer}` },
        { on: h, cmd: 'ip -s neigh' },
      ] as ProtoStepInput[];
    }),

    { section: 'ARP — cas négatifs / mal formés', on: 'lhq', cmd: 'arp -s 10.1.1.99 zz:zz:zz:zz:zz:zz' },
    { on: 'lhq', cmd: 'ip neigh add 999.1.1.1 lladdr 02:00:00:00:00:99 dev eth0' },
    { on: 'lhq', cmd: 'arp' },
    { on: 'rhq', cmd: 'show ip arp 300.1.1.1' },
    { on: 'rhq', cmd: 'arp 10.1.1.1' },
    { on: 'rbr', cmd: 'arp static' },
    { on: 'rbr', cmd: 'display arp xyz' },
    { on: 'whq', cmd: 'arp -s' },
    { on: 'whq', cmd: 'arp -x' },

    { section: 'ARP — désactivation debug & état final', on: 'rhq', cmd: 'undebug all' },
    { on: 'rdc', cmd: 'undebug all' },
    { on: 'rbr', cmd: 'undo debugging all' },
    { on: 'rhq', cmd: 'show ip arp' },
    { on: 'rdc', cmd: 'show ip arp' },
    { on: 'rbr', cmd: 'display arp all' },
    { on: 'swhq', cmd: 'show mac address-table' },
    { on: 'swbr', cmd: 'display mac-address' },
    ...each(lH, (h) => ([
      { on: h, cmd: 'ip neigh show' },
      { on: h, cmd: 'arp -e' },
    ] as ProtoStepInput[])),
    ...each(wH, (h) => ({ on: h, cmd: 'arp -a' } as ProtoStepInput)),
    { on: 'rhq', cmd: 'show logging' },
    { on: 'rbr', cmd: 'display logbuffer' },
  ];
}

describe('debug — protocol ARP (RFC 826) across the enterprise WAN', () => {
  it('exercises ARP resolution, static/proxy/gratuitous ARP and caches across vendors', async () => {
    resetSim();
    const wan = buildEnterpriseWAN();
    await initializeWAN(wan);

    const steps = buildSteps();
    expect(steps.length).toBeGreaterThanOrEqual(300);

    await dumpProtocol(
      'arp',
      wan.topology,
      steps,
      'protocol=ARP (RFC 826) — focus: résolution, ARP statique/proxy/gratuit, vidage de cache, ' +
      'inspection L2 MAC, durcissement sysctl — multi-vendor (Cisco/Huawei/Linux/Windows/generic)',
    );
  }, 300000);
});
