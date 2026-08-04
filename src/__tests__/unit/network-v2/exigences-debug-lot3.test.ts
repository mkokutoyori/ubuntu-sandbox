import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

async function priv(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await run(r, 'enable');
  await run(r, 'configure terminal');
  await run(r, 'router ospf 1');
  await run(r, 'end');
  return r;
}

describe('D1 — les debugs ne sont jamais persistés', () => {
  it('aucune ligne debug dans la running-config', async () => {
    const r = await priv();
    await run(r, 'debug ip ospf events');
    await run(r, 'debug arp');
    expect(await run(r, 'show running-config')).not.toMatch(/(^|\n)\s*debug /);
  });

  it('un reload remet tous les drapeaux à zéro', async () => {
    const r = await priv();
    await run(r, 'debug ip ospf events');
    expect(await run(r, 'show debugging')).toContain('OSPF events debugging is on');
    await run(r, 'reload');
    await run(r, 'yes');
    await run(r, 'enable');
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });
});

describe('D2 — debug réservé au mode privilégié', () => {
  it('refusé en mode configuration', async () => {
    const r = await priv();
    await run(r, 'configure terminal');
    expect(await run(r, 'debug ip ospf events')).toContain("% Invalid input detected at '^' marker.");
  });

  it('refusé en mode utilisateur', async () => {
    const r = new CiscoRouter('R1');
    const sortie = await run(r, 'debug ip ospf events');
    expect(sortie).toMatch(/Invalid input|Unrecognized command/);
    expect(sortie).not.toContain('debugging is on');
  });
});

describe('D4 — extinction ciblée', () => {
  it('no debug arp ne coupe que ARP', async () => {
    const r = await priv();
    await run(r, 'debug ip ospf events');
    await run(r, 'debug arp');
    await run(r, 'no debug arp');
    const out = await run(r, 'show debugging');
    expect(out).toContain('OSPF events debugging is on');
    expect(out).not.toContain('ARP packet debugging is on');
  });

  it('undebug all coupe tout', async () => {
    const r = await priv();
    await run(r, 'debug ip ospf events');
    await run(r, 'debug arp');
    expect(await run(r, 'undebug all')).toContain('All possible debugging has been turned off');
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });
});

describe('D5 — show debugging groupe les drapeaux par module', () => {
  it('chaque module a son en-tête et ses lignes indentées', async () => {
    const r = await priv();
    await run(r, 'debug arp');
    await run(r, 'debug ip ospf events');
    await run(r, 'debug ip ospf packet');
    const out = await run(r, 'show debugging');
    const lignes = out.split('\n');

    expect(lignes).toContain('ARP:');
    expect(lignes).toContain('OSPF:');
    expect(out).toMatch(/^ {2}ARP packet debugging is on$/m);
    expect(out).toMatch(/^ {2}OSPF events debugging is on$/m);
    expect(out).toMatch(/^ {2}OSPF packet debugging is on$/m);

    const iOspf = lignes.indexOf('OSPF:');
    expect(lignes[iOspf + 1].startsWith('  ')).toBe(true);
    expect(lignes[iOspf + 2].startsWith('  ')).toBe(true);
  });

  it('sans drapeau, le message reste celui d\'IOS', async () => {
    const r = await priv();
    expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
  });
});

describe('D9 — abréviations CLI', () => {
  it('deb ip ospf ev active bien events, pas adjacency', async () => {
    const r = await priv();
    expect(await run(r, 'deb ip ospf ev')).toContain('OSPF events debugging is on');
    const out = await run(r, 'show debugging');
    expect(out).toContain('OSPF events debugging is on');
    expect(out).not.toContain('adjacency');
  });

  it('u all, un all et no deb all éteignent tout', async () => {
    for (const raccourci of ['u all', 'un all', 'no deb all']) {
      EquipmentRegistry.resetInstance();
      const r = await priv();
      await run(r, 'debug ip ospf events');
      expect(await run(r, raccourci)).toContain('All possible debugging has been turned off');
      expect(await run(r, 'show debugging')).toContain('No debug flags are enabled');
    }
  });

  it('deb ip ospf hel vise hello', async () => {
    const r = await priv();
    expect(await run(r, 'deb ip ospf hel')).toContain('OSPF Hello debugging is on');
  });
});

describe('D10 — avertissement sur les debugs volumineux', () => {
  it('debug ip packet prévient avant de confirmer', async () => {
    const r = await priv();
    const out = await run(r, 'debug ip packet');
    expect(out).toContain('MUST NOT be used on production networks; High CPU utilization may occur.');
    expect(out).toContain('IP packet debugging is on');
    expect(out.indexOf('MUST NOT')).toBeLessThan(out.indexOf('IP packet debugging is on'));
  });

  it('un debug ordinaire ne porte pas l\'avertissement', async () => {
    const r = await priv();
    expect(await run(r, 'debug ip ospf events')).not.toContain('MUST NOT');
  });
});

describe('D3 — debug condition filtre réellement', () => {
  it('debug condition ip est accepté et listé', async () => {
    const r = await priv();
    expect(await run(r, 'debug condition ip 192.168.10.50')).toContain('Condition 1 set');
    const out = await run(r, 'show debug condition');
    expect(out).toContain('ip');
    expect(out).toContain('192.168.10.50');
  });

  it('sans condition, show debug condition le dit', async () => {
    const r = await priv();
    expect(await run(r, 'show debug condition')).toContain('Condition 1 is not set');
  });

  it('une condition écarte les lignes qui ne la mentionnent pas', async () => {
    const r = await priv();
    const vues: string[] = [];
    r.getDebugService().subscribe((l: string) => vues.push(l));
    await run(r, 'debug ip packet');
    await run(r, 'debug condition ip 10.9.9.9');

    r.getDebugService().emitLine('ip.packet', 'IP: s=10.9.9.9 (Gi0/0), d=1.1.1.1, len 100, forward');
    r.getDebugService().emitLine('ip.packet', 'IP: s=172.16.0.1 (Gi0/0), d=1.1.1.1, len 100, forward');

    expect(vues.some(l => l.includes('10.9.9.9'))).toBe(true);
    expect(vues.some(l => l.includes('172.16.0.1'))).toBe(false);
  });

  it('no debug condition all lève le filtre', async () => {
    const r = await priv();
    await run(r, 'debug condition ip 10.9.9.9');
    expect(await run(r, 'no debug condition all')).toContain('All conditions have been removed');
    expect(await run(r, 'show debug condition')).toContain('Condition 1 is not set');
  });
});

describe('D6 — service timestamps debug uptime', () => {
  it('bascule l\'horodatage sur le compteur de fonctionnement', async () => {
    const r = await priv();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    await run(r, 'configure terminal');
    await run(r, 'service timestamps debug uptime');
    await run(r, 'end');
    await run(r, 'debug ip ospf events');

    journal.append('debugging', 'ospf', 'OSPF: test');
    expect(vues.at(-1)).toMatch(/^\*\d{2}:\d{2}:\d{2}: /);
  });

  it('datetime reste le format à date', async () => {
    const r = await priv();
    const journal = r.getLoggingConfig()!;
    const vues: string[] = [];
    journal.subscribeConsole((l) => vues.push(l));
    await run(r, 'configure terminal');
    await run(r, 'service timestamps debug datetime msec');
    await run(r, 'end');
    await run(r, 'debug ip ospf events');

    journal.append('debugging', 'ospf', 'OSPF: test');
    expect(vues.at(-1)).toMatch(/^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: /);
  });
});

describe('D7 — les debugs sont recopiés dans le tampon', () => {
  it('show logging retrouve une ligne de debug émise plus tôt', async () => {
    const r = await priv();
    await run(r, 'debug ip packet');
    r.getDebugService().emitLine('ip.packet',
      'IP: s=192.168.1.1 (Gi0/0), d=10.0.0.2 (Gi0/1), g=10.0.0.2, len 100, forward');

    const journal = await run(r, 'show logging');
    expect(journal).toContain('IP: s=192.168.1.1');
    expect(journal).toContain('len 100, forward');
  });
});

describe('D8 — en-tête IP détaillé', () => {
  it('le format porte source, destination, passerelle et longueur', async () => {
    const r = await priv();
    const vues: string[] = [];
    r.getDebugService().subscribe((l: string) => vues.push(l));
    await run(r, 'debug ip packet');
    r.getDebugService().emitLine('ip.packet',
      'IP: s=192.168.10.1 (GigabitEthernet0/0.10), d=10.0.0.2 (GigabitEthernet0/2), g=10.0.0.2, len 100, forward');

    expect(vues.at(-1)).toMatch(
      /^IP: s=\d+\.\d+\.\d+\.\d+ \([^)]+\), d=\d+\.\d+\.\d+\.\d+ \([^)]+\), g=\d+\.\d+\.\d+\.\d+, len \d+, forward$/);
  });
});
