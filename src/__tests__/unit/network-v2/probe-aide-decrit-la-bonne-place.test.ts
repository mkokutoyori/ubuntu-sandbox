/**
 * L'aide decrit la place OU L'ON EST, pas la suivante.
 *
 * Defaut mesure (audit completion, M4) :
 *
 *     (config-if)# ip access-group ?
 *       in   Inbound direction
 *       out  Outbound direction
 *
 * La syntaxe est `ip access-group {numero | nom} {in | out}`. A cette
 * place, IOS attend la LISTE, et rend `<1-199>` / `<1300-2699>` / `WORD`.
 * Ce qui s'affichait etait l'aide de la place SUIVANTE.
 *
 * La consequence n'est pas cosmetique : l'aide saute un argument
 * obligatoire en silence. Celui qui la suit tape `ip access-group in`,
 * et la machine reclame la liste — l'aide et l'analyseur ne decrivent
 * pas la meme commande.
 *
 * Le cas revele une lacune du modele plutot qu'un oubli de declaration :
 * a cette place IOS accepte TROIS formes, et un `ParamSpec` n'en rendait
 * qu'une. `alternatives` les nomme toutes les trois, chacune avec sa
 * propre description, comme la vraie machine.
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

type Dev = { cliHelp(s: string): string; executeCommand(c: string): Promise<string> };

const MOT = /^\s\s(\S+)\s\s/;
const offerts = (t: string): string[] =>
  t.includes('Invalid input') ? []
    : t.split('\n').map((l) => MOT.exec(l)?.[1]).filter((x): x is string => !!x);
const annonceCr = (t: string): boolean =>
  t.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;
async function surInterface(): Promise<Dev> {
  const r = new CiscoRouter(`A${serie++}`) as unknown as Dev;
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) {
    await r.executeCommand(c);
  }
  return r;
}

describe('M4 — `ip access-group ?` decrit la liste, pas la direction', () => {
  it('rend les trois formes qu IOS accepte a cette place', async () => {
    const r = await surInterface();
    const o = offerts(r.cliHelp('ip access-group '));
    expect(o).toContain('<1-199>');
    expect(o).toContain('<1300-2699>');
    expect(o).toContain('WORD');
  });

  it('et plus la direction, qui appartient a la place suivante', async () => {
    const r = await surInterface();
    const o = offerts(r.cliHelp('ip access-group '));
    expect(o).not.toContain('in');
    expect(o).not.toContain('out');
  });

  it('la direction revient une fois la liste nommee', async () => {
    const r = await surInterface();
    const o = offerts(r.cliHelp('ip access-group 10 '));
    expect(o).toContain('in');
    expect(o).toContain('out');
  });

  it('chaque forme porte sa propre description', async () => {
    const r = await surInterface();
    const aide = r.cliHelp('ip access-group ');
    expect(aide).toMatch(/<1-199>\s+\S/);
    expect(aide).toMatch(/<1300-2699>\s+\S/);
    expect(aide).toMatch(/WORD\s+\S/);
  });

  it('et la commande complete s execute toujours', async () => {
    const r = await surInterface();
    expect(String(await r.executeCommand('ip access-group 10 in'))).not.toContain('Invalid');
  });
});

describe('la meme faute chez les voisins', () => {
  it('`ipv6 traffic-filter ?` nomme la liste et n annonce plus `<cr>`', async () => {
    const r = await surInterface();
    const aide = r.cliHelp('ipv6 traffic-filter ');
    expect(offerts(aide)).toContain('WORD');
    // Il manque DEUX mots : `<cr>` promettait une commande complete.
    expect(annonceCr(aide)).toBe(false);
  });

  it('et la direction y revient aussi une fois la liste nommee', async () => {
    const r = await surInterface();
    const o = offerts(r.cliHelp('ipv6 traffic-filter LISTE '));
    expect(o).toContain('in');
    expect(o).toContain('out');
  });

  it('`service-policy ?` garde input/output — la direction Y EST premiere', async () => {
    const r = await surInterface();
    const o = offerts(r.cliHelp('service-policy '));
    expect(o).toContain('input');
    expect(o).toContain('output');
    // Mais il manque encore le nom de la politique.
    expect(annonceCr(r.cliHelp('service-policy '))).toBe(false);
  });

  it('`access-class ?` nomme la liste', async () => {
    const r = new CiscoRouter(`V${serie++}`) as unknown as Dev;
    for (const c of ['enable', 'configure terminal', 'line vty 0 4']) await r.executeCommand(c);
    const o = offerts(r.cliHelp('access-class '));
    expect(o).toContain('<1-199>');
    expect(o).toContain('WORD');
    expect(o).not.toContain('in');
  });
});

describe('non-regression — une place a forme unique ne bouge pas', () => {
  it('`ip address ?` rend toujours `A.B.C.D`', async () => {
    const r = await surInterface();
    expect(offerts(r.cliHelp('ip address '))).toContain('A.B.C.D');
  });

  it('`ip policy ?` rend toujours `route-map`', async () => {
    const r = await surInterface();
    expect(offerts(r.cliHelp('ip policy '))).toContain('route-map');
  });

  it('`ip ospf cost ?` rend toujours sa borne', async () => {
    const r = await surInterface();
    expect(offerts(r.cliHelp('ip ospf cost '))).toContain('<1-65535>');
  });
});
