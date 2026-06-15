import { describe, it } from 'vitest';
import { buildLan, dumpL2, resetSim, type L2StepInput } from './_l2-lan-suite';

const HOSTS: Array<{ key: string; ip: string }> = [
  { key: 'l1', ip: '192.168.1.11' },
  { key: 'w1', ip: '192.168.1.12' },
  { key: 'srv1', ip: '192.168.1.13' },
  { key: 'l2', ip: '192.168.1.21' },
  { key: 'w2', ip: '192.168.1.22' },
  { key: 'srv2', ip: '192.168.1.23' },
];

function pingCmd(on: string, ip: string): { on: string; cmd: string } {
  const win = on === 'w1' || on === 'w2';
  return { on, cmd: win ? `ping -n 2 ${ip}` : `ping -c 2 ${ip}` };
}

describe('debug-dump: cisco-l2-08-mac-forwarding', () => {
  it('writes the transcript', async () => {
    resetSim();
    const { topology } = await buildLan();
    const s: L2StepInput[] = [];

    s.push({ section: 'baseline MAC table', cmd: 'enable' });
    for (const c of [
      'show mac address-table', 'show mac address-table count',
      'show mac address-table dynamic', 'show mac address-table static',
      'show mac address-table aging-time', 'show mac address-table vlan 1',
    ]) s.push(c);

    s.push({ section: 'full connectivity matrix (VLAN 1, all pairs)' });
    for (const src of HOSTS) {
      for (const dst of HOSTS) {
        if (src.key === dst.key) continue;
        s.push(pingCmd(src.key, dst.ip));
      }
    }

    s.push({ section: 'MAC table populated by matrix', on: 'sw1', cmd: 'show mac address-table' });
    s.push({ on: 'sw1', cmd: 'show mac address-table count' });
    s.push({ on: 'sw2', cmd: 'show mac address-table' });
    s.push({ on: 'core', cmd: 'enable' });
    s.push({ on: 'core', cmd: 'show mac address-table' });

    s.push({ section: 'host ARP/neighbor tables after matrix' });
    for (const h of HOSTS) {
      const win = h.key === 'w1' || h.key === 'w2';
      s.push({ on: h.key, cmd: win ? 'arp -a' : 'arp -n' });
    }

    s.push({ section: 'static MAC entries loop', on: 'sw1', cmd: 'configure terminal' });
    for (let i = 1; i <= 10; i++) {
      const mac = `0000.dead.${i.toString().padStart(4, '0')}`;
      s.push({ on: 'sw1', cmd: `mac address-table static ${mac} vlan 1 interface FastEthernet0/${i}` });
    }
    s.push({ on: 'sw1', cmd: 'mac address-table aging-time 120' });
    s.push({ on: 'sw1', cmd: 'mac address-table notification change' });
    s.push({ on: 'sw1', cmd: 'end' });
    s.push({ on: 'sw1', cmd: 'show mac address-table static' });
    s.push({ on: 'sw1', cmd: 'show mac address-table aging-time' });

    s.push({ section: 'unicast flooding after clear', on: 'sw1', cmd: 'show mac address-table dynamic' });
    s.push({ on: 'sw1', cmd: 'clear mac address-table dynamic' });
    s.push({ on: 'sw1', cmd: 'show mac address-table dynamic' });
    s.push(pingCmd('l1', '192.168.1.13'));
    s.push({ on: 'sw1', cmd: 'show mac address-table dynamic' });
    s.push({ on: 'sw1', cmd: 'clear mac address-table dynamic vlan 1' });
    s.push({ on: 'sw1', cmd: 'show mac address-table count' });
    s.push({ on: 'sw1', cmd: 'clear mac address-table dynamic interface FastEthernet0/1' });
    s.push({ on: 'sw1', cmd: 'clear mac address-table dynamic address 0000.dead.0001' });

    s.push({ section: 'MAC move via link bounce', on: 'sw1', cmd: 'configure terminal' });
    s.push({ on: 'sw1', cmd: 'interface FastEthernet0/3' });
    s.push({ on: 'sw1', cmd: 'shutdown' });
    s.push({ on: 'sw1', cmd: 'do show mac address-table' });
    s.push({ on: 'sw1', cmd: 'no shutdown' });
    s.push({ on: 'sw1', cmd: 'end' });
    s.push(pingCmd('srv1', '192.168.1.11'));
    s.push({ on: 'sw1', cmd: 'show mac address-table' });

    s.push({ section: 'second connectivity matrix (re-learn)' });
    for (const src of HOSTS) {
      for (const dst of HOSTS) {
        if (src.key === dst.key) continue;
        s.push(pingCmd(src.key, dst.ip));
      }
    }

    s.push({ section: 'per-VLAN MAC inspection loop' });
    for (const v of [1, 10, 20, 30, 40, 50]) {
      s.push({ on: 'sw1', cmd: `show mac address-table vlan ${v}` });
    }
    s.push({ section: 'per-interface MAC inspection loop' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'sw1', cmd: `show mac address-table interface FastEthernet0/${i}` });
    }

    s.push({ section: 'broadcast / unknown-unicast behavior' });
    s.push(pingCmd('l1', '192.168.1.99'));
    s.push({ on: 'sw1', cmd: 'show mac address-table' });
    s.push({ on: 'l1', cmd: 'arp -n' });

    s.push({ section: 'interface counters after traffic' });
    for (let i = 1; i <= 3; i++) {
      s.push({ on: 'sw1', cmd: `show interfaces FastEthernet0/${i} counters` });
      s.push({ on: 'sw1', cmd: `show interfaces FastEthernet0/${i}` });
    }

    s.push({ section: 'host MAC/link verification' });
    s.push({ on: 'l1', cmd: 'ip -br link' });
    s.push({ on: 'srv1', cmd: 'ip -br link' });
    s.push({ on: 'w1', cmd: 'getmac' });
    s.push({ on: 'w2', cmd: 'getmac' });
    s.push({ on: 'l2', cmd: 'ip neigh' });
    s.push({ on: 'srv2', cmd: 'arp -n' });

    s.push({ section: 'interface counters loop (SW1 Fa0/1..0/23)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'sw1', cmd: `show interfaces FastEthernet0/${i} counters` });
    }
    s.push({ section: 'per-interface MAC inspection loop (SW2)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'sw2', cmd: `show mac address-table interface FastEthernet0/${i}` });
    }
    s.push({ section: 'per-interface MAC inspection loop (CORE)' });
    for (let i = 1; i <= 23; i++) {
      s.push({ on: 'core', cmd: `show mac address-table interface FastEthernet0/${i}` });
    }
    s.push({ section: 'extended static MAC entries (SW2)', on: 'sw2', cmd: 'configure terminal' });
    for (let i = 1; i <= 10; i++) {
      const mac = `0000.beef.${i.toString().padStart(4, '0')}`;
      s.push({ on: 'sw2', cmd: `mac address-table static ${mac} vlan 1 interface FastEthernet0/${i}` });
    }
    s.push({ on: 'sw2', cmd: 'end' });
    s.push({ on: 'sw2', cmd: 'show mac address-table static' });

    s.push({ section: 'full host inspection' });
    for (const h of HOSTS) {
      const win = h.key === 'w1' || h.key === 'w2';
      s.push({ on: h.key, cmd: win ? 'ipconfig /all' : 'ip -br addr' });
      s.push({ on: h.key, cmd: win ? 'arp -a' : 'ip neigh' });
      s.push({ on: h.key, cmd: win ? 'getmac' : 'ip -br link' });
    }

    s.push({ section: 'final MAC state' });
    s.push({ on: 'sw1', cmd: 'show mac address-table' });
    s.push({ on: 'sw1', cmd: 'show mac address-table count' });
    s.push({ on: 'sw2', cmd: 'show mac address-table' });
    s.push({ on: 'core', cmd: 'show mac address-table' });
    s.push({ on: 'sw1', cmd: 'show running-config' });

    await dumpL2('cisco-l2-08-mac-forwarding', topology, s,
      'focus=CAM table, static MACs, aging, clear variants, unicast flooding, MAC move, connectivity matrix');
  }, 180000);
});
