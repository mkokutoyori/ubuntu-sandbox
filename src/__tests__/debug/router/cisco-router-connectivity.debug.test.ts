/**
 * Cisco router — end-to-end routed connectivity gap-analysis (~300).
 * Brings up R1+R2 with addressing, then exercises the data path under
 * static routing, OSPF, RIP and DHCP, with host (Linux/Windows) ping/
 * traceroute, ARP/route inspection, and fault-injection + recovery.
 */
import { describe, it } from 'vitest';
import {
  buildCiscoLab, dumpRouter, resetSim, regressionSweep, each, type RouterStepInput,
} from './_router-suite';

const cfgR1 = (extra: string[] = []): RouterStepInput[] => ([
  { on: 'r1', cmd: 'enable' },
  { on: 'r1', cmd: 'configure terminal' },
  { on: 'r1', cmd: 'hostname R1' },
  { on: 'r1', cmd: 'interface GigabitEthernet0/0' },
  { on: 'r1', cmd: 'ip address 192.168.1.1 255.255.255.0' },
  { on: 'r1', cmd: 'no shutdown' },
  { on: 'r1', cmd: 'exit' },
  { on: 'r1', cmd: 'interface GigabitEthernet0/1' },
  { on: 'r1', cmd: 'ip address 10.0.0.1 255.255.255.252' },
  { on: 'r1', cmd: 'no shutdown' },
  { on: 'r1', cmd: 'exit' },
  ...extra.map((c) => ({ on: 'r1', cmd: c })),
  { on: 'r1', cmd: 'end' },
]);

const cfgR2 = (extra: string[] = []): RouterStepInput[] => ([
  { on: 'r2', cmd: 'enable' },
  { on: 'r2', cmd: 'configure terminal' },
  { on: 'r2', cmd: 'hostname R2' },
  { on: 'r2', cmd: 'interface GigabitEthernet0/0' },
  { on: 'r2', cmd: 'ip address 192.168.2.1 255.255.255.0' },
  { on: 'r2', cmd: 'no shutdown' },
  { on: 'r2', cmd: 'exit' },
  { on: 'r2', cmd: 'interface GigabitEthernet0/1' },
  { on: 'r2', cmd: 'ip address 10.0.0.2 255.255.255.252' },
  { on: 'r2', cmd: 'no shutdown' },
  { on: 'r2', cmd: 'exit' },
  ...extra.map((c) => ({ on: 'r2', cmd: c })),
  { on: 'r2', cmd: 'end' },
]);

const verify = (label: string): RouterStepInput[] => ([
  { section: `verify (${label})`, on: 'r1', cmd: 'show ip interface brief' },
  { on: 'r1', cmd: 'show ip route' },
  { on: 'r2', cmd: 'show ip route' },
  { on: 'r1', cmd: 'ping 10.0.0.2' },
  { on: 'r1', cmd: 'ping 192.168.2.1' },
  { on: 'r2', cmd: 'ping 192.168.1.1' },
  { on: 'linux1', cmd: 'ping -c 3 192.168.1.1' },
  { on: 'linux1', cmd: 'ping -c 3 10.0.0.2' },
  { on: 'linux1', cmd: 'ping -c 3 192.168.2.1' },
  { on: 'linux1', cmd: 'ping -c 3 192.168.2.10' },
  { on: 'linux1', cmd: 'traceroute 192.168.2.10' },
  { on: 'win1', cmd: 'ping 192.168.1.10' },
  { on: 'win1', cmd: 'tracert 192.168.1.10' },
  { on: 'r1', cmd: 'show ip arp' },
  { on: 'r2', cmd: 'show ip arp' },
]);

describe('debug-dump: cisco-router-connectivity', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = buildCiscoLab();
    const steps: RouterStepInput[] = [
      // ── hosts ───────────────────────────────────────────────────
      { section: 'host setup', on: 'linux1', cmd: 'ip addr add 192.168.1.10/24 dev eth0' },
      { on: 'linux1', cmd: 'ip link set eth0 up' },
      { on: 'linux1', cmd: 'ip route add default via 192.168.1.1' },
      { on: 'linux1', cmd: 'ip addr show eth0' },
      { on: 'linux1', cmd: 'ip route show' },
      { on: 'win1', cmd: 'netsh interface ip set address eth0 static 192.168.2.10 255.255.255.0 192.168.2.1' },
      { on: 'win1', cmd: 'ipconfig /all' },
      { on: 'win1', cmd: 'route print' },

      // ── Scenario 1: static routing ──────────────────────────────
      { section: 'scenario 1: static routing', on: 'r1', cmd: 'enable' },
      ...cfgR1(['ip route 192.168.2.0 255.255.255.0 10.0.0.2']),
      ...cfgR2(['ip route 192.168.1.0 255.255.255.0 10.0.0.1']),
      ...verify('static'),

      // ── Scenario 2: default routes ──────────────────────────────
      { section: 'scenario 2: default routes', on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'no ip route 192.168.2.0 255.255.255.0 10.0.0.2' },
      { on: 'r1', cmd: 'ip route 0.0.0.0 0.0.0.0 10.0.0.2' },
      { on: 'r1', cmd: 'end' },
      { on: 'r2', cmd: 'configure terminal' },
      { on: 'r2', cmd: 'no ip route 192.168.1.0 255.255.255.0 10.0.0.1' },
      { on: 'r2', cmd: 'ip route 0.0.0.0 0.0.0.0 10.0.0.1' },
      { on: 'r2', cmd: 'end' },
      ...verify('default'),

      // ── Scenario 3: OSPF ────────────────────────────────────────
      { section: 'scenario 3: OSPF', on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'no ip route 0.0.0.0 0.0.0.0 10.0.0.2' },
      { on: 'r1', cmd: 'router ospf 1' },
      { on: 'r1', cmd: 'router-id 1.1.1.1' },
      { on: 'r1', cmd: 'network 192.168.1.0 0.0.0.255 area 0' },
      { on: 'r1', cmd: 'network 10.0.0.0 0.0.0.3 area 0' },
      { on: 'r1', cmd: 'end' },
      { on: 'r2', cmd: 'configure terminal' },
      { on: 'r2', cmd: 'no ip route 0.0.0.0 0.0.0.0 10.0.0.1' },
      { on: 'r2', cmd: 'router ospf 1' },
      { on: 'r2', cmd: 'router-id 2.2.2.2' },
      { on: 'r2', cmd: 'network 192.168.2.0 0.0.0.255 area 0' },
      { on: 'r2', cmd: 'network 10.0.0.0 0.0.0.3 area 0' },
      { on: 'r2', cmd: 'end' },
      { on: 'r1', cmd: 'show ip ospf neighbor' },
      { on: 'r1', cmd: 'show ip ospf interface brief' },
      { on: 'r1', cmd: 'show ip ospf database' },
      { on: 'r2', cmd: 'show ip ospf neighbor' },
      ...verify('ospf'),

      // ── Scenario 4: RIP ─────────────────────────────────────────
      { section: 'scenario 4: RIP', on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'no router ospf 1' },
      { on: 'r1', cmd: 'router rip' },
      { on: 'r1', cmd: 'version 2' },
      { on: 'r1', cmd: 'no auto-summary' },
      { on: 'r1', cmd: 'network 192.168.1.0' },
      { on: 'r1', cmd: 'network 10.0.0.0' },
      { on: 'r1', cmd: 'end' },
      { on: 'r2', cmd: 'configure terminal' },
      { on: 'r2', cmd: 'no router ospf 1' },
      { on: 'r2', cmd: 'router rip' },
      { on: 'r2', cmd: 'version 2' },
      { on: 'r2', cmd: 'no auto-summary' },
      { on: 'r2', cmd: 'network 192.168.2.0' },
      { on: 'r2', cmd: 'network 10.0.0.0' },
      { on: 'r2', cmd: 'end' },
      { on: 'r1', cmd: 'show ip rip database' },
      { on: 'r2', cmd: 'show ip rip database' },
      ...verify('rip'),

      // ── Scenario 5: DHCP-assigned host ──────────────────────────
      { section: 'scenario 5: DHCP', on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'ip dhcp excluded-address 192.168.1.1 192.168.1.9' },
      { on: 'r1', cmd: 'ip dhcp pool LAN1' },
      { on: 'r1', cmd: 'network 192.168.1.0 255.255.255.0' },
      { on: 'r1', cmd: 'default-router 192.168.1.1' },
      { on: 'r1', cmd: 'dns-server 8.8.8.8' },
      { on: 'r1', cmd: 'exit' },
      { on: 'r1', cmd: 'end' },
      { on: 'linux1', cmd: 'ip addr flush dev eth0' },
      { on: 'linux1', cmd: 'dhclient eth0' },
      { on: 'linux1', cmd: 'ip addr show eth0' },
      { on: 'linux1', cmd: 'ping -c 3 192.168.1.1' },
      { on: 'linux1', cmd: 'ping -c 3 192.168.2.1' },
      { on: 'r1', cmd: 'show ip dhcp binding' },
      { on: 'r1', cmd: 'show ip dhcp pool' },

      // ── Scenario 6: NAT/PAT to "Internet" ───────────────────────
      { section: 'scenario 6: NAT/PAT', on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'interface GigabitEthernet0/0' },
      { on: 'r1', cmd: 'ip nat inside' },
      { on: 'r1', cmd: 'exit' },
      { on: 'r1', cmd: 'interface GigabitEthernet0/1' },
      { on: 'r1', cmd: 'ip nat outside' },
      { on: 'r1', cmd: 'exit' },
      { on: 'r1', cmd: 'access-list 1 permit 192.168.1.0 0.0.0.255' },
      { on: 'r1', cmd: 'ip nat inside source list 1 interface GigabitEthernet0/1 overload' },
      { on: 'r1', cmd: 'end' },
      { on: 'linux1', cmd: 'ping -c 3 192.168.2.1' },
      { on: 'linux1', cmd: 'ping -c 3 192.168.2.10' },
      { on: 'r1', cmd: 'show ip nat translations' },
      { on: 'r1', cmd: 'show ip nat statistics' },

      // ── Scenario 7: fault injection + recovery ──────────────────
      { section: 'scenario 7: link fault', on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'interface GigabitEthernet0/1' },
      { on: 'r1', cmd: 'shutdown' },
      { on: 'r1', cmd: 'end' },
      { on: 'r1', cmd: 'show ip interface brief' },
      { on: 'linux1', cmd: 'ping -c 2 192.168.2.10' },
      { on: 'r1', cmd: 'show ip route' },
      { on: 'r1', cmd: 'configure terminal' },
      { on: 'r1', cmd: 'interface GigabitEthernet0/1' },
      { on: 'r1', cmd: 'no shutdown' },
      { on: 'r1', cmd: 'end' },
      { on: 'r1', cmd: 'show ip interface brief' },
      { on: 'linux1', cmd: 'ping -c 3 192.168.2.10' },

      // ── Scenario 8: misconfig diagnosis ─────────────────────────
      { section: 'scenario 8: wrong mask', on: 'r2', cmd: 'configure terminal' },
      { on: 'r2', cmd: 'interface GigabitEthernet0/1' },
      { on: 'r2', cmd: 'ip address 10.0.0.2 255.255.255.0' },
      { on: 'r2', cmd: 'end' },
      { on: 'r1', cmd: 'ping 10.0.0.2' },
      { on: 'linux1', cmd: 'ping -c 2 192.168.2.10' },
      { on: 'r2', cmd: 'configure terminal' },
      { on: 'r2', cmd: 'interface GigabitEthernet0/1' },
      { on: 'r2', cmd: 'ip address 10.0.0.2 255.255.255.252' },
      { on: 'r2', cmd: 'end' },
      { on: 'linux1', cmd: 'ping -c 3 192.168.2.10' },

      // ── final state dump ────────────────────────────────────────
      { section: 'final state', on: 'r1', cmd: 'show running-config' },
      { on: 'r2', cmd: 'show running-config' },
      ...each([
        'show ip route', 'show ip arp', 'show ip protocols',
        'show ip interface brief', 'show interfaces GigabitEthernet0/1',
      ], (c) => ({ on: 'r1', cmd: c })),
      { on: 'linux1', cmd: 'arp -n' },
      { on: 'linux1', cmd: 'ip route show' },
      { on: 'win1', cmd: 'arp -a' },
      { on: 'win1', cmd: 'netstat -rn' },
      ...regressionSweep('cisco'),
    ];
    await dumpRouter('cisco-router-connectivity', topology, steps,
      'focus=routed data path: static/default/OSPF/RIP/DHCP/NAT + faults');
  }, 180000);
});
