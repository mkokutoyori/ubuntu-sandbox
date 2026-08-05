import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});
afterEach(() => { __setDefaultScheduler(null); });

const run = (d: { executeCommand(c: string): string | Promise<string> }, c: string) =>
  Promise.resolve(d.executeCommand(c));

async function routeurPriv(nom = 'Router1'): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom);
  await run(r, 'enable');
  return r;
}

describe('TP — encapsulation dot1q exige son VLAN', () => {
  it('sans numéro de VLAN, la commande est incomplète', async () => {
    const r = await routeurPriv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0.10');
    expect(await run(r, 'encapsulation dot1q')).toBe('% Incomplete command.');
  });

  it('et l\'encapsulation n\'est pas posée, donc ip address reste refusé', async () => {
    const r = await routeurPriv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0.10');
    await run(r, 'encapsulation dot1q');
    expect(await run(r, 'ip address 192.168.10.1 255.255.255.0'))
      .toContain('subinterface');
  });

  it('avec un numéro, elle passe', async () => {
    const r = await routeurPriv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0.10');
    expect(await run(r, 'encapsulation dot1q 10')).toBe('');
    expect(await run(r, 'ip address 192.168.10.1 255.255.255.0')).toBe('');
  });

  it('un argument non numérique reste refusé', async () => {
    const r = await routeurPriv();
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0.10');
    expect(await run(r, 'encapsulation dot1q abc')).toContain('Invalid input');
  });
});

describe('TP — show cdp neighbors : Holdtme décompte et colonnes alignées', () => {
  async function pairCable(): Promise<[CiscoRouter, CiscoSwitch]> {
    const r = await routeurPriv();
    const s = new CiscoSwitch('switch-cisco', 'Switch1');
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, s.getPort('FastEthernet0/1')!);
    await run(r, 'configure terminal');
    await run(r, 'interface GigabitEthernet0/0');
    await run(r, 'no shutdown');
    await run(r, 'end');
    return [r, s];
  }

  const ligneVoisin = (sortie: string) =>
    sortie.split('\n').find(l => /^Switch1/.test(l)) ?? '';

  it('le Holdtme décompte au lieu de rester figé à 180', async () => {
    const [r] = await pairCable();
    const depart = ligneVoisin(await run(r, 'show cdp neighbors'));
    expect(depart).toMatch(/\s180\s/);

    horloge.advance(20_000);
    const apres = ligneVoisin(await run(r, 'show cdp neighbors'));
    const valeur = Number(apres.match(/\s(\d{1,3})\s{2,}/)?.[1] ?? -1);
    expect(valeur).toBeGreaterThan(150);
    expect(valeur).toBeLessThan(180);
  });

  it('un hello reçu remet le compteur au holdtime annoncé', async () => {
    const [r] = await pairCable();
    horloge.advance(20_000);
    horloge.advance(45_000);
    const apres = ligneVoisin(await run(r, 'show cdp neighbors'));
    const valeur = Number(apres.match(/\s(\d{1,3})\s{2,}/)?.[1] ?? -1);
    expect(valeur).toBeGreaterThan(150);
  });

  it('la colonne Port ID reste alignée sur son en-tête', async () => {
    const [r] = await pairCable();
    const sortie = await run(r, 'show cdp neighbors');
    const entete = sortie.split('\n').find(l => l.startsWith('Device ID')) ?? '';
    const colonne = entete.indexOf('Port ID');
    const ligne = ligneVoisin(sortie);
    expect(colonne).toBeGreaterThan(0);
    expect(ligne.length).toBeGreaterThan(colonne);
    expect(ligne.slice(colonne).trim()).toMatch(/^(Fas|Gig|Eth)/);
  });
});

describe('TP — show interfaces status est une commande de commutateur', () => {
  it('un routeur la refuse', async () => {
    const r = await routeurPriv();
    expect(await run(r, 'show interfaces status'))
      .toContain("% Invalid input detected at '^' marker.");
  });

  it('un commutateur l\'accepte et nomme ses ports entièrement', async () => {
    const s = new CiscoSwitch('switch-cisco', 'Switch1');
    await run(s, 'enable');
    const sortie = await run(s, 'show interfaces status');
    expect(sortie).toContain('Port');
    expect(sortie).not.toMatch(/^GigabitEt\s/m);
    expect(sortie).toMatch(/^(Fa|Gi)\d+\/\d+/m);
  });
});
