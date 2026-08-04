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
