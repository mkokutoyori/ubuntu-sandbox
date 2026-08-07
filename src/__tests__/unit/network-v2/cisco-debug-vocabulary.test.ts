/**
 * PRD-Debug-Fidelite-Cisco.md §5 / §7.5-§7.6 — lot D5.
 *
 * Un fait, un libelle. Aucun identifiant interne dans une sortie. Et
 * les lignes emises prennent la forme d'IOS plutot qu'une forme a nous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serial = 0;
const debugOf = (d: unknown) =>
  (d as { getDebugService(): { subscribe(f: (l: string) => void): () => void } }).getDebugService();

async function pair(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const id = ++serial;
  const a = new CiscoRouter(`VA${id}`);
  const b = new CiscoRouter(`VB${id}`);
  new Cable(`vc${id}`).connect(a.getPorts()[0], b.getPorts()[0]);
  for (const [d, ip] of [[a, '10.0.12.1'], [b, '10.0.12.2']] as const) {
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end']) {
      await d.executeCommand(c);
    }
  }
  return { a, b };
}

describe('one fact, one wording', () => {
  it('the command and the view name an access list the same way', async () => {
    const { a } = await pair();
    const armement = await a.executeCommand('debug ip packet 100');
    expect(armement).toBe('IP packet debugging is on for access list 100');
    expect(await a.executeCommand('show debugging')).toContain(armement);
  });

  it('`detail` is carried by both, and so is an interface scope', async () => {
    const { a } = await pair();
    expect(await a.executeCommand('debug ip packet 100 detail'))
      .toBe('IP packet debugging is on for access list 100 (detailed)');
    expect(await a.executeCommand('show debugging'))
      .toContain('IP packet debugging is on for access list 100 (detailed)');
    await a.executeCommand('undebug all');
    const iface = await a.executeCommand('debug interface GigabitEthernet0/0');
    expect(await a.executeCommand('show debugging')).toContain(iface.trim());
  });

  it('arming a debug prints no invented warning', async () => {
    const { a } = await pair();
    for (const c of ['debug ip packet', 'debug ip tcp', 'debug ip udp']) {
      expect(await a.executeCommand(c), c).not.toMatch(/MUST NOT be used|High CPU/);
      await a.executeCommand('undebug all');
    }
  });
});

describe('no output leaks an internal identifier', () => {
  it('neither platform prints a dotted category name', async () => {
    const r = new CiscoRouter(`VI${++serial}`);
    await r.executeCommand('enable');
    const sw = new CiscoSwitch('switch-cisco', `VS${serial}`, 24, 0, 0);
    await sw.executeCommand('enable');
    const sorties: string[] = [];
    for (const c of ['debug ip packet', 'debug ip ospf adj', 'debug standby', 'show debugging']) {
      sorties.push(await r.executeCommand(c));
    }
    for (const c of ['debug spanning-tree', 'debug mac address-table', 'show debugging',
      'undebug all', 'show debugging']) {
      sorties.push(await sw.executeCommand(c));
    }
    for (const s of sorties) {
      expect(s, s).not.toMatch(/\b(ip|stp|crypto|ntp|aaa)\.[a-z-]+\b/);
    }
  });

  it('the switch says `off`, not `off (disabled)`', async () => {
    const sw = new CiscoSwitch('switch-cisco', `VD${++serial}`, 24, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('debug spanning-tree');
    expect(await sw.executeCommand('no debug spanning-tree')).not.toMatch(/\(disabled\)/);
    expect(await sw.executeCommand('undebug all')).toBe('All possible debugging has been turned off');
  });

  it('the switch lists what is armed instead of a single sentence', async () => {
    const sw = new CiscoSwitch('switch-cisco', `VL${++serial}`, 24, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('debug mac address-table');
    const shown = await sw.executeCommand('show debugging');
    expect(shown).toContain('MAC address table debugging is on');
    expect(shown).not.toBe('All debugging is on');
  });
});

describe('`show debugging` groups the way IOS groups', () => {
  it('a rubric is written only when it has content, and the order is fixed', async () => {
    const { a } = await pair();
    for (const c of ['debug crypto isakmp', 'debug ip ospf adj', 'debug ip icmp',
      'debug ip packet', 'debug standby']) {
      await a.executeCommand(c);
    }
    const shown = await a.executeCommand('show debugging');
    const rubriques = shown.split('\n').filter((l) => /^\S.*:$/.test(l));
    expect(rubriques).toEqual(['Generic IP:', 'OSPF:', 'First-hop redundancy:', 'Crypto Subsystem:']);
    for (const r of rubriques) {
      const i = shown.split('\n').indexOf(r);
      expect(shown.split('\n')[i + 1], r).toMatch(/^ {2}\S/);
    }
  });

  it('no rubric appears for a family that is not armed', async () => {
    const { a } = await pair();
    await a.executeCommand('debug ip icmp');
    const shown = await a.executeCommand('show debugging');
    expect(shown).toContain('Generic IP:');
    expect(shown).not.toContain('OSPF:');
    expect(shown).not.toContain('Crypto Subsystem:');
  });
});

describe('the lines themselves read like IOS', () => {
  it('an IP packet names both interfaces and says sending / rcvd', async () => {
    const { a } = await pair();
    await a.executeCommand('debug ip packet');
    const l: string[] = [];
    collecteDebug(debugOf(a), l);
    await a.executeCommand('ping 10.0.12.2 repeat 1');
    expect(l.some((x) => /^IP: s=10\.0\.12\.1 \(local\), d=10\.0\.12\.2 \(GigabitEthernet0\/0\), len \d+, sending$/.test(x))).toBe(true);
    expect(l.some((x) => /^IP: s=\S+ \(GigabitEthernet0\/0\), d=\S+ \(GigabitEthernet0\/0\), len \d+, rcvd \d+$/.test(x))).toBe(true);
    expect(l.every((x) => !/\(proto \d+\)/.test(x))).toBe(true);
  });

  it('a routing-table change carries the prefix length, the source and the metric', async () => {
    const { a } = await pair();
    await a.executeCommand('debug ip routing');
    const l: string[] = [];
    collecteDebug(debugOf(a), l);
    for (const c of ['configure terminal', 'ip route 192.168.9.0 255.255.255.0 10.0.12.2', 'end']) {
      await a.executeCommand(c);
    }
    expect(l.some((x) => /^RT: add 192\.168\.9\.0\/24 via 10\.0\.12\.2, static metric \[\d+\/\d+\]$/.test(x))).toBe(true);
  });

  it('an OSPF packet says which packet it is', async () => {
    const { a, b } = await pair();
    await a.executeCommand('debug ip ospf packet');
    await a.executeCommand('debug ip ospf hello');
    const l: string[] = [];
    collecteDebug(debugOf(a), l);
    for (const d of [a, b]) {
      for (const c of ['configure terminal', 'router ospf 1',
        'network 10.0.12.0 0.0.0.255 area 0', 'end']) {
        await d.executeCommand(c);
      }
    }
    expect(l.some((x) => /^OSPF: snd\. v:2 t:1 \(Hello\) to 224\.0\.0\.5 on \S+$/.test(x))).toBe(true);
    expect(l.some((x) => /^OSPF: rcv\. v:2 t:2 \(Data Description\) from \S+ on \S+$/.test(x))).toBe(true);
    expect(l.every((x) => !/\(unknown\)/.test(x))).toBe(true);
    expect(l.some((x) => /^OSPF: Send hello to 224\.0\.0\.5 area \S+ on \S+/.test(x))).toBe(true);
  });

  it('`debug ip ospf adj` prints adjacency lines, not a syslog message', async () => {
    const { a, b } = await pair();
    await a.executeCommand('debug ip ospf adj');
    const l: string[] = [];
    collecteDebug(debugOf(a), l);
    for (const d of [a, b]) {
      for (const c of ['configure terminal', 'router ospf 1',
        'network 10.0.12.0 0.0.0.255 area 0', 'end']) {
        await d.executeCommand(c);
      }
    }
    expect(l.some((x) => /^OSPF: \S+ Nbr \S+ state \w+ -> \w+, event \w+$/.test(x))).toBe(true);
    expect(l.every((x) => !/ADJCHG/.test(x))).toBe(true);
  });
});
