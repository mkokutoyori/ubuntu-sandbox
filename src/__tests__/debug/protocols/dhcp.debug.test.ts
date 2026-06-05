import { describe, it, expect } from 'vitest';
import {
  buildEnterpriseWAN, initializeWAN, resetSim, dumpProtocol,
  each, SITE, WAN, type ProtoStepInput,
} from './_enterprise-wan';

interface Client { on: string; win: boolean; gw: string; site: string }
const CLIENTS: Client[] = [
  { on: 'lhq', win: false, gw: SITE.hq.gw, site: 'HQ' },
  { on: 'whq', win: true, gw: SITE.hq.gw, site: 'HQ' },
  { on: 'lbr', win: false, gw: SITE.br.gw, site: 'BR' },
  { on: 'wbr', win: true, gw: SITE.br.gw, site: 'BR' },
  { on: 'ldc', win: false, gw: SITE.dc.gw, site: 'DC' },
];

const acquire = (c: Client): ProtoStepInput[] => (c.win
  ? [
    { on: c.on, cmd: 'ipconfig /release' },
    { on: c.on, cmd: 'ipconfig /renew' },
    { on: c.on, cmd: 'ipconfig /all' },
    { on: c.on, cmd: `ping -n 1 ${c.gw}` },
  ]
  : [
    { on: c.on, cmd: 'ip addr flush dev eth0' },
    { on: c.on, cmd: 'dhclient -v eth0' },
    { on: c.on, cmd: 'ip addr show eth0' },
    { on: c.on, cmd: 'ip route show' },
    { on: c.on, cmd: `ping -c 1 ${c.gw}` },
  ]);

function buildSteps(): ProtoStepInput[] {
  return [
    { section: 'DHCP — activation logs & debug (Cisco)', on: 'rhq', cmd: 'enable' },
    ...each(['rhq', 'rdc'], (r) => ([
      { on: r, cmd: 'terminal monitor' },
      { on: r, cmd: 'debug ip dhcp server events' },
      { on: r, cmd: 'debug ip dhcp server packet' },
      { on: r, cmd: 'show debugging' },
    ] as ProtoStepInput[])),
    { section: 'DHCP — activation logs & debug (Huawei)', on: 'rbr', cmd: 'terminal monitor' },
    { on: 'rbr', cmd: 'terminal debugging' },
    { on: 'rbr', cmd: 'debugging dhcp server all' },
    { on: 'rbr', cmd: 'display debugging' },

    { section: 'DHCP serveur HQ (Cisco) — pool LAN-HQ', on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ip dhcp excluded-address 10.1.1.1 10.1.1.9' },
    { on: 'rhq', cmd: 'ip dhcp pool LAN-HQ' },
    { on: 'rhq', cmd: 'network 10.1.1.0 255.255.255.0' },
    { on: 'rhq', cmd: 'default-router 10.1.1.1' },
    { on: 'rhq', cmd: 'dns-server 10.3.3.10 8.8.8.8' },
    { on: 'rhq', cmd: 'domain-name acme.example' },
    { on: 'rhq', cmd: 'lease 0 8 0' },
    { on: 'rhq', cmd: 'exit' },
    { on: 'rhq', cmd: 'service dhcp' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rhq', cmd: 'show ip dhcp pool' },
    { on: 'rhq', cmd: 'show running-config | section dhcp' },

    { section: 'DHCP serveur DC (Cisco) — pool LAN-DC (réserve SRV-DC)', on: 'rdc', cmd: 'configure terminal' },
    { on: 'rdc', cmd: 'ip dhcp excluded-address 10.3.3.1 10.3.3.10' },
    { on: 'rdc', cmd: 'ip dhcp pool LAN-DC' },
    { on: 'rdc', cmd: 'network 10.3.3.0 255.255.255.0' },
    { on: 'rdc', cmd: 'default-router 10.3.3.1' },
    { on: 'rdc', cmd: 'dns-server 10.3.3.10' },
    { on: 'rdc', cmd: 'lease 2 0 0' },
    { on: 'rdc', cmd: 'exit' },
    { on: 'rdc', cmd: 'end' },
    { on: 'rdc', cmd: 'show ip dhcp pool' },

    { section: 'DHCP serveur BR (Huawei) — ip pool LAN-BR', on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'dhcp enable' },
    { on: 'rbr', cmd: 'ip pool LAN-BR' },
    { on: 'rbr', cmd: 'network 10.2.2.0 mask 255.255.255.0' },
    { on: 'rbr', cmd: 'gateway-list 10.2.2.1' },
    { on: 'rbr', cmd: 'dns-list 10.3.3.10 8.8.8.8' },
    { on: 'rbr', cmd: 'excluded-ip-address 10.2.2.1 10.2.2.9' },
    { on: 'rbr', cmd: 'lease day 1' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'interface GigabitEthernet0/0/0' },
    { on: 'rbr', cmd: 'dhcp select global' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'display ip pool' },
    { on: 'rbr', cmd: 'display ip pool name LAN-BR' },

    { section: 'DHCP — bascule des clients (DORA)', on: 'lhq', cmd: 'ip addr flush dev eth0' },
    ...each(CLIENTS, (c) => acquire(c)),

    { section: 'DHCP — joignabilité avec adresses obtenues', on: 'lhq', cmd: `ping -c 1 ${SITE.hq.gw}` },
    { on: 'lhq', cmd: `ping -c 1 ${SITE.dc.srv}` },
    { on: 'wbr', cmd: `ping -n 1 ${SITE.hq.gw}` },
    { on: 'ldc', cmd: `ping -c 1 ${SITE.br.gw}` },
    { on: 'lbr', cmd: `ping -c 1 ${SITE.dc.srv}` },
    { on: 'whq', cmd: `ping -n 1 ${SITE.br.gw}` },

    { section: 'DHCP — baux côté serveur', on: 'rhq', cmd: 'show ip dhcp binding' },
    { on: 'rhq', cmd: 'show ip dhcp pool' },
    { on: 'rhq', cmd: 'show ip dhcp server statistics' },
    { on: 'rdc', cmd: 'show ip dhcp binding' },
    { on: 'rdc', cmd: 'show ip dhcp pool' },
    { on: 'rbr', cmd: 'display ip pool name LAN-BR' },
    { on: 'rbr', cmd: 'display dhcp server statistics' },
    { on: 'rbr', cmd: 'display dhcp server ip-in-use' },

    { section: 'DHCP — baux côté client', on: 'lhq', cmd: 'cat /var/lib/dhcp/dhclient.leases' },
    ...each(['lhq', 'lbr', 'ldc'], (h) => ([
      { on: h, cmd: 'cat /var/lib/dhcp/dhclient.leases' },
      { on: h, cmd: 'ip -4 addr show eth0' },
      { on: h, cmd: 'cat /etc/resolv.conf' },
    ] as ProtoStepInput[])),
    ...each(['whq', 'wbr'], (h) => ([
      { on: h, cmd: 'ipconfig' },
      { on: h, cmd: 'ipconfig /displaydns' },
    ] as ProtoStepInput[])),

    { section: 'DHCP — renouvellement (T1) & libération', on: 'lhq', cmd: 'dhclient -v eth0' },
    ...each(CLIENTS, (c) => (c.win
      ? [
        { on: c.on, cmd: 'ipconfig /renew' },
        { on: c.on, cmd: 'ipconfig | findstr IPv4' },
      ]
      : [
        { on: c.on, cmd: 'dhclient -v eth0' },
        { on: c.on, cmd: 'ip -4 addr show eth0' },
      ]) as ProtoStepInput[]),
    { on: 'rhq', cmd: 'show ip dhcp binding' },
    ...each(CLIENTS, (c) => (c.win
      ? [{ on: c.on, cmd: 'ipconfig /release' }, { on: c.on, cmd: 'ipconfig' }]
      : [{ on: c.on, cmd: 'dhclient -r eth0' }, { on: c.on, cmd: 'ip -4 addr show eth0' }]) as ProtoStepInput[]),
    { on: 'rhq', cmd: 'show ip dhcp binding' },
    { on: 'rbr', cmd: 'display dhcp server ip-in-use' },
    ...each(CLIENTS, (c) => acquire(c).slice(0, 2)),

    { section: 'DHCP — réservation / static binding', on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ip dhcp pool RES-HQ' },
    { on: 'rhq', cmd: 'host 10.1.1.50 255.255.255.0' },
    { on: 'rhq', cmd: 'client-identifier 0100.0000.0000.4b' },
    { on: 'rhq', cmd: 'default-router 10.1.1.1' },
    { on: 'rhq', cmd: 'exit' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rhq', cmd: 'show ip dhcp pool RES-HQ' },
    { on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'ip pool LAN-BR' },
    { on: 'rbr', cmd: 'static-bind ip-address 10.2.2.60 mac-address 0200-0000-0050' },
    { on: 'rbr', cmd: 'display this' },
    { on: 'rbr', cmd: 'undo static-bind ip-address 10.2.2.60' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rbr', cmd: 'quit' },

    { section: 'DHCP — exclusions & conflits', on: 'rhq', cmd: 'show ip dhcp conflict' },
    { on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ip dhcp excluded-address 10.1.1.100 10.1.1.120' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rhq', cmd: 'show running-config | include excluded' },
    { on: 'lhq', cmd: 'arp -s 10.1.1.45 02:00:00:00:00:99' },
    { on: 'rhq', cmd: 'clear ip dhcp conflict *' },
    { on: 'rhq', cmd: 'show ip dhcp conflict' },
    { on: 'rdc', cmd: 'show ip dhcp conflict' },

    { section: 'DHCP snooping — Cisco SW-HQ', on: 'swhq', cmd: 'configure terminal' },
    { on: 'swhq', cmd: 'ip dhcp snooping' },
    { on: 'swhq', cmd: 'ip dhcp snooping vlan 1' },
    { on: 'swhq', cmd: 'interface FastEthernet0/1' },
    { on: 'swhq', cmd: 'ip dhcp snooping trust' },
    { on: 'swhq', cmd: 'exit' },
    { on: 'swhq', cmd: 'interface FastEthernet0/2' },
    { on: 'swhq', cmd: 'ip dhcp snooping limit rate 10' },
    { on: 'swhq', cmd: 'exit' },
    { on: 'swhq', cmd: 'end' },
    { on: 'swhq', cmd: 'show ip dhcp snooping' },
    { on: 'swhq', cmd: 'show ip dhcp snooping binding' },

    { section: 'DHCP snooping — Huawei SW-BR', on: 'swbr', cmd: 'system-view' },
    { on: 'swbr', cmd: 'dhcp enable' },
    { on: 'swbr', cmd: 'dhcp snooping enable' },
    { on: 'swbr', cmd: 'interface GigabitEthernet0/0/1' },
    { on: 'swbr', cmd: 'dhcp snooping trusted' },
    { on: 'swbr', cmd: 'quit' },
    { on: 'swbr', cmd: 'quit' },
    { on: 'swbr', cmd: 'display dhcp snooping' },
    { on: 'swbr', cmd: 'display dhcp snooping user-bind all' },

    { section: 'DHCP relay — R-DC relaie vers serveur central HQ', on: 'rdc', cmd: 'configure terminal' },
    { on: 'rdc', cmd: 'no ip dhcp pool LAN-DC' },
    { on: 'rdc', cmd: 'interface GigabitEthernet0/0' },
    { on: 'rdc', cmd: `ip helper-address ${WAN.hqdc.hq}` },
    { on: 'rdc', cmd: 'exit' },
    { on: 'rdc', cmd: 'end' },
    { on: 'rdc', cmd: 'show ip interface GigabitEthernet0/0 | include Helper' },
    { on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ip dhcp pool RELAY-DC' },
    { on: 'rhq', cmd: 'network 10.3.3.0 255.255.255.0' },
    { on: 'rhq', cmd: 'default-router 10.3.3.1' },
    { on: 'rhq', cmd: 'exit' },
    { on: 'rhq', cmd: 'end' },
    { on: 'ldc', cmd: 'ip addr flush dev eth0' },
    { on: 'ldc', cmd: 'dhclient -v eth0' },
    { on: 'ldc', cmd: 'ip addr show eth0' },
    { on: 'rdc', cmd: 'show ip dhcp relay statistics' },
    { on: 'rhq', cmd: 'show ip dhcp binding' },

    { section: 'DHCP — statistiques & compteurs', on: 'rhq', cmd: 'show ip dhcp server statistics' },
    { on: 'rdc', cmd: 'show ip dhcp server statistics' },
    { on: 'rbr', cmd: 'display dhcp server statistics' },
    { on: 'rbr', cmd: 'display dhcp statistics' },
    ...each(['lhq', 'lbr', 'ldc'], (h) => ({ on: h, cmd: 'cat /var/lib/dhcp/dhclient.leases' } as ProtoStepInput)),
    { on: 'whq', cmd: 'ipconfig /all' },

    { section: 'DHCP — matrice de connectivité post-bail', on: 'lhq', cmd: `ping -c 1 ${SITE.hq.win}` },
    ...each(CLIENTS, (c) => {
      const targets = [SITE.hq.gw, SITE.br.gw, SITE.dc.gw, SITE.dc.srv];
      return each(targets, (t) => ({ on: c.on, cmd: c.win ? `ping -n 1 ${t}` : `ping -c 1 ${t}` } as ProtoStepInput));
    }),

    { section: 'DHCP — inspection détaillée des pools/baux', on: 'rhq', cmd: 'show ip dhcp pool LAN-HQ' },
    { on: 'rhq', cmd: 'show ip dhcp binding 10.1.1.10' },
    { on: 'rhq', cmd: 'show running-config | section ip dhcp' },
    { on: 'rdc', cmd: 'show running-config | section ip dhcp' },
    { on: 'rbr', cmd: 'display ip pool name LAN-BR all' },
    { on: 'rbr', cmd: 'display dhcp server ip-in-use pool LAN-BR' },
    { on: 'rbr', cmd: 'display current-configuration configuration dhcp' },
    { on: 'lhq', cmd: 'cat /etc/resolv.conf' },
    { on: 'lbr', cmd: 'ip route show default' },
    { on: 'ldc', cmd: 'ip route show default' },

    { section: 'DHCP — DECLINE / INFORM / changement d\'options', on: 'lhq', cmd: 'dhclient -r eth0' },
    { on: 'lhq', cmd: 'arp -s 10.1.1.30 02:00:00:00:00:30' },
    { on: 'lhq', cmd: 'dhclient -v eth0' },
    { on: 'lhq', cmd: 'ip -4 addr show eth0' },
    { on: 'rhq', cmd: 'show ip dhcp conflict' },
    { on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ip dhcp pool LAN-HQ' },
    { on: 'rhq', cmd: 'dns-server 1.1.1.1 8.8.4.4' },
    { on: 'rhq', cmd: 'option 42 ip 10.3.3.10' },
    { on: 'rhq', cmd: 'netbios-name-server 10.3.3.10' },
    { on: 'rhq', cmd: 'exit' },
    { on: 'rhq', cmd: 'end' },
    { on: 'whq', cmd: 'ipconfig /release' },
    { on: 'whq', cmd: 'ipconfig /renew' },
    { on: 'whq', cmd: 'ipconfig /all' },

    { section: 'DHCPv6 — serveur & client (best-effort)', on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'dhcp enable' },
    { on: 'rbr', cmd: 'ipv6 dhcp server V6POOL' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ipv6 dhcp pool V6-HQ' },
    { on: 'rhq', cmd: 'address prefix 2001:db8:1::/64' },
    { on: 'rhq', cmd: 'dns-server 2001:4860:4860::8888' },
    { on: 'rhq', cmd: 'exit' },
    { on: 'rhq', cmd: 'interface GigabitEthernet0/0' },
    { on: 'rhq', cmd: 'ipv6 dhcp server V6-HQ' },
    { on: 'rhq', cmd: 'exit' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rhq', cmd: 'show ipv6 dhcp pool' },
    { on: 'lhq', cmd: 'dhclient -6 -v eth0' },
    { on: 'lhq', cmd: 'ip -6 addr show eth0' },
    { on: 'whq', cmd: 'ipconfig /all' },

    { section: 'DHCP — cas négatifs / mal formés', on: 'rhq', cmd: 'configure terminal' },
    { on: 'rhq', cmd: 'ip dhcp pool' },
    { on: 'rhq', cmd: 'network 999.0.0.0 255.255.255.0' },
    { on: 'rhq', cmd: 'end' },
    { on: 'rbr', cmd: 'system-view' },
    { on: 'rbr', cmd: 'ip pool' },
    { on: 'rbr', cmd: 'gateway-list' },
    { on: 'rbr', cmd: 'quit' },
    { on: 'lhq', cmd: 'dhclient' },
    { on: 'lhq', cmd: 'dhclient eth99' },
    { on: 'whq', cmd: 'ipconfig /renew eth99' },

    { section: 'DHCP — désactivation debug & état final', on: 'rhq', cmd: 'undebug all' },
    { on: 'rdc', cmd: 'undebug all' },
    { on: 'rbr', cmd: 'undo debugging all' },
    { on: 'rhq', cmd: 'show ip dhcp binding' },
    { on: 'rbr', cmd: 'display ip pool' },
    { on: 'rhq', cmd: 'show ip dhcp pool' },
    { on: 'swhq', cmd: 'show ip dhcp snooping binding' },
    { on: 'swbr', cmd: 'display dhcp snooping user-bind all' },
    ...each(CLIENTS, (c) => ({ on: c.on, cmd: c.win ? 'ipconfig' : 'ip -4 addr show eth0' } as ProtoStepInput)),
    { on: 'rhq', cmd: 'show ip dhcp server statistics' },
    { on: 'rdc', cmd: 'show ip dhcp relay statistics' },
    { on: 'rbr', cmd: 'display dhcp server statistics' },
    { on: 'rhq', cmd: 'show logging' },
    { on: 'rbr', cmd: 'display logbuffer' },
  ];
}

describe('debug — protocol DHCP (RFC 2131) across the enterprise WAN', () => {
  it('exercises DORA, leases, reservations, relay and snooping across vendors', async () => {
    resetSim();
    const wan = buildEnterpriseWAN();
    await initializeWAN(wan);

    const steps = buildSteps();
    expect(steps.length).toBeGreaterThanOrEqual(300);

    await dumpProtocol(
      'dhcp',
      wan.topology,
      steps,
      'protocol=DHCP (RFC 2131) — focus: DORA, baux/renouvellement/libération, réservations, ' +
      'relais (ip helper-address), snooping L2, exclusions/conflits, statistiques — ' +
      'serveurs Cisco/Huawei, clients Linux(dhclient)/Windows(ipconfig)',
    );
  }, 300000);
});
