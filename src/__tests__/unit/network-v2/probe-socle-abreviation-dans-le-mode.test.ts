/**
 * Une abreviation se juge dans le VOCABULAIRE DU MODE.
 *
 * MESURE DE DEPART, sur un CiscoRouter en `config-router` (RIP) :
 *
 *   R(config-router)# ?        -> ... passive-interface ... (un seul mot en p)
 *   R(config-router)# Tab «p»  -> ["passive-interface"]
 *   R(config-router)# p        -> % Ambiguous command:  "p"
 *   R(config-router)# pa       -> % Ambiguous command:  "pa"
 *
 * L'aide et la tabulation disent la meme chose -- un seul mot -- et
 * l'EXECUTION en dit une troisieme. C'est exactement l'invariant que
 * CLAUDE.md pose (« `?` et `Tab` repondent a la meme question ») pris en
 * defaut par un TROISIEME predicat, celui de l'analyseur.
 *
 * LA CAUSE, mesuree et non supposee : l'arbre du socle est PLAT a sa
 * racine, et `subtreeReachable` y admet, depuis un sous-mode, toute
 * commande declaree pour un mode ANCETRE -- l'heritage que CLAUDE.md
 * nomme parmi les pieges du socle. Le sous-mode `config-router` voyait
 * donc concourir `password`, `parity`, `path`, `parser`,
 * `parameter-map`, `pass` et `path-echo`, tous declares ailleurs, avec
 * le seul `passive-interface` qui est le sien. L'aide, elle, filtre au
 * mode STRICT, d'ou le desaccord.
 *
 * CE QUI TRANCHE : une vraie machine resout l'abreviation dans le
 * vocabulaire du mode ou l'on se trouve. `pa` en `config-router` ne peut
 * pas etre `password` : ce mot n'y est pas propose, et ce qu'une CLI ne
 * propose pas, elle ne le devine pas non plus. L'heritage reste -- une
 * commande globale tapee EN ENTIER depuis un sous-mode continue de
 * passer -- mais il ne concourt plus pour l'abreviation.
 *
 * Sonde ecrite AVANT correctif.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Routeur = CiscoRouter & { cliHelp(s: string): string };

async function enModeRouteur(nom: string): Promise<Routeur> {
  const r = new CiscoRouter(nom) as Routeur;
  for (const c of ['enable', 'configure terminal', 'router rip']) {
    await r.executeCommand(c);
  }
  return r;
}

const mots = (aide: string): string[] =>
  aide.split('\n').map(l => /^\s\s(\S+)/.exec(l)?.[1]).filter((m): m is string => !!m);

describe('socle : l abreviation se juge dans le mode', () => {
  it('TEMOIN : le mot entier du mode s execute', async () => {
    const r = await enModeRouteur('R0');
    expect(await r.executeCommand('passive-interface GigabitEthernet0/0'))
      .not.toContain('Ambiguous');
  });

  it('l aide du mode ne propose QU UN mot en `p`', async () => {
    const r = await enModeRouteur('R1');
    const enP = mots(r.cliHelp('')).filter(m => m.startsWith('p'));
    expect(enP).toEqual(['passive-interface']);
  });

  it('`p` se resout donc, au lieu d etre declare ambigu', async () => {
    const r = await enModeRouteur('R2');
    const res = await r.executeCommand('p');
    expect(res).not.toContain('Ambiguous');
    expect(res).toContain('% Incomplete command.');
  });

  it('`pa` aussi, et il designe le mot du mode', async () => {
    const r = await enModeRouteur('R3');
    expect(await r.executeCommand('pa GigabitEthernet0/0'))
      .not.toContain('Ambiguous');
  });

  it('NON-REGRESSION : en configuration globale, `p` reste ambigu', async () => {
    const r = new CiscoRouter('R4') as Routeur;
    for (const c of ['enable', 'configure terminal']) await r.executeCommand(c);
    const enP = mots(r.cliHelp('')).filter(m => m.startsWith('p'));
    expect(enP.length).toBeGreaterThan(1);
    expect(await r.executeCommand('p')).toContain('Ambiguous');
  });

  it('NON-REGRESSION : une commande globale ENTIERE passe encore', async () => {
    const r = await enModeRouteur('R5');
    expect(await r.executeCommand('hostname ROUTEUR')).not.toContain('Invalid');
    expect(r.getHostname()).toBe('ROUTEUR');
  });
});
