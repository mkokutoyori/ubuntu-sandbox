/**
 * `<cr>` promet une chose et une seule : vous pouvez valider ICI.
 *
 * Defaut mesure (audit completion, M6) : l'aide annoncait `<cr>` sur des
 * commandes qui repondent `% Incomplete command.` a la validation.
 *
 *     ? «clock »              annonce <cr>   ->  «clock»  -> % Incomplete command.
 *     ? «ip access-group »    annonce <cr>   ->  refuse de meme
 *     ? «route-map »          annonce <cr>   ->  idem
 *
 * La cause est declarative et non algorithmique : `<cr>` s'affiche des
 * qu'un noeud porte une action et que son ARITE MINIMALE vaut zero.
 * `requiredArity` la deduit deja des parametres declares non optionnels —
 * mais ces noeuds-la n'en declarent aucun, donc elle vaut zero, donc la
 * machine annonce qu'on peut valider une commande a laquelle il manque
 * un mot.
 *
 * Ce fichier est un GARDE-FOU plutot qu'une liste de cas : il balaie
 * l'arbre d'aide de trois modes, et pour chaque `<cr>` annonce il
 * VALIDE la commande sur une machine neuve. Un `<cr>` qui ne tient pas
 * sa promesse fait echouer le balayage en le nommant. C'est ainsi que la
 * liste des trente-deux fautes a ete etablie, et c'est ce qui empechera
 * la trente-troisieme.
 *
 * Une machine NEUVE par validation : la commande validee peut modifier
 * la configuration, et un balayage qui s'observe lui-meme ne mesure plus
 * rien.
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
    : t.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((x): x is string => !!x && x !== '<cr>');
const annonceCr = (t: string): boolean =>
  t.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;
async function neuf(prelude: readonly string[]): Promise<Dev> {
  const r = new CiscoRouter(`M${serie++}`) as unknown as Dev;
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

/** Les `<cr>` annonces qui ne tiennent pas, dans un mode donne. */
async function crMensongers(prelude: readonly string[], racine: string): Promise<string[]> {
  const guide = await neuf(prelude);
  const fautes: string[] = [];
  const vus = new Set<string>();
  let file = [racine];
  for (let p = 0; p < 3; p++) {
    const suivant: string[] = [];
    for (const base of file) {
      const aide = guide.cliHelp(base === '' ? '' : `${base} `);
      if (base !== '' && annonceCr(aide)) {
        const essai = await neuf(prelude);
        const out = String(await essai.executeCommand(base));
        if (out.includes('Incomplete')) fautes.push(`«${base} ?» annonce <cr>`);
      }
      for (const k of offerts(aide)) {
        // Les substituts (`WORD`, `A.B.C.D`, `<1-9>`) ne sont pas des
        // mots-cles : on ne descend pas dedans.
        if (k.startsWith('<') || /^[A-Z0-9.:$/-]+$/.test(k)) continue;
        const chemin = base === '' ? k : `${base} ${k}`;
        if (vus.has(chemin)) continue;
        vus.add(chemin);
        if (suivant.length < 240) suivant.push(chemin);
      }
    }
    file = suivant;
  }
  return fautes;
}

describe('M6 — un `<cr>` annonce se valide vraiment', () => {
  it('en EXEC privilegie, branche `show`', async () => {
    const f = await crMensongers([], 'show');
    expect(f, f.join('\n')).toEqual([]);
  }, 240_000);

  it('en configuration globale', async () => {
    const f = await crMensongers(['configure terminal'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 300_000);

  it('en configuration d interface', async () => {
    const f = await crMensongers(
      ['configure terminal', 'interface GigabitEthernet0/0'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 240_000);
});

describe('les cas nommes de l audit', () => {
  it.each([
    ['clock', ['configure terminal']],
    ['class-map', ['configure terminal']],
    ['policy-map', ['configure terminal']],
    ['route-map', ['configure terminal']],
    ['ip access-group', ['configure terminal', 'interface GigabitEthernet0/0']],
    ['ip ospf', ['configure terminal', 'interface GigabitEthernet0/0']],
    ['ipv6 ospf', ['configure terminal', 'interface GigabitEthernet0/0']],
    ['rate-limit input', ['configure terminal', 'interface GigabitEthernet0/0']],
  ] as Array<[string, string[]]>)('`%s ?` n annonce plus `<cr>`', async (cmd, pre) => {
    const r = await neuf(pre);
    expect(annonceCr(r.cliHelp(`${cmd} `)), cmd).toBe(false);
  });
});

describe('non-regression — un `<cr>` legitime reste', () => {
  it.each([
    ['show version', []],
    ['show clock', []],
    ['show ip route', []],
    ['shutdown', ['configure terminal', 'interface GigabitEthernet0/0']],
    ['no shutdown', ['configure terminal', 'interface GigabitEthernet0/0']],
  ] as Array<[string, string[]]>)('`%s ?` annonce `<cr>`', async (cmd, pre) => {
    const r = await neuf(pre);
    expect(annonceCr(r.cliHelp(`${cmd} `)), cmd).toBe(true);
    expect(String(await r.executeCommand(cmd)), cmd).not.toContain('Incomplete');
  });
});
