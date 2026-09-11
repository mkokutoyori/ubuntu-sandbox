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
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
type Fabrique = () => Dev;

const ROUTEUR: Fabrique = () => new CiscoRouter(`M${serie++}`) as unknown as Dev;
const CATALYST: Fabrique = () =>
  new CiscoSwitch('switch-cisco', `S${serie++}`, 8, 0, 0) as unknown as Dev;

async function neuf(
  prelude: readonly string[], fabrique: Fabrique = ROUTEUR,
): Promise<Dev> {
  const r = fabrique();
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

/**
 * Les `<cr>` annonces qui ne tiennent pas, dans un mode donne.
 *
 * La PROFONDEUR est un parametre parce qu'elle se gagne : une branche
 * entre ici a trois rangs, et passe a quatre le jour ou elle est propre
 * a quatre. Le balayage promene a quatre a trouve ce que celui a trois
 * ne voyait pas — `aaa accounting commands`, `copy flash:`,
 * `terminal length` — et l'y inscrire avant correction reviendrait a
 * epingler le defaut au lieu de le mesurer.
 */
async function crMensongers(
  prelude: readonly string[], racine: string, fabrique: Fabrique = ROUTEUR,
  profondeur = 3,
): Promise<string[]> {
  const guide = await neuf(prelude, fabrique);
  const fautes: string[] = [];
  const vus = new Set<string>();
  let file = [racine];
  for (let p = 0; p < profondeur; p++) {
    const suivant: string[] = [];
    for (const base of file) {
      const aide = guide.cliHelp(base === '' ? '' : `${base} `);
      if (base !== '' && annonceCr(aide)) {
        const essai = await neuf(prelude, fabrique);
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
        if (suivant.length < 400) suivant.push(chemin);
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
    const f = await crMensongers(['configure terminal'], '', ROUTEUR, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en configuration d interface', async () => {
    const f = await crMensongers(
      ['configure terminal', 'interface GigabitEthernet0/0'], '', ROUTEUR, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en EXEC privilegie, depuis la racine', async () => {
    const f = await crMensongers([], '', ROUTEUR, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  /*
   * Le balayage n'entrait dans AUCUN sous-mode, et c'est la que les
   * `<cr>` menteurs se sont accumules : 77 mesures dans huit sous-modes
   * le jour ou on l'y a promene. Ils sont nommes dans TODO.md, et
   * chaque famille migree au socle en ferme un lot — le socle deduit
   * l'arite des places declarees, la ou un noeud du trie sans parametre
   * annonce zero.
   *
   * `config-view` est le premier a entrer ici parce qu'il est le
   * premier a etre entierement declare. Le suivant s'ajoute a cette
   * liste quand il l'est ; l'ajouter avant reviendrait a epingler le
   * defaut au lieu de le mesurer.
   */
  it('dans le sous-mode `parser view`', async () => {
    const f = await crMensongers(
      ['configure terminal', 'aaa new-model', 'parser view NOC'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 240_000);

  it('dans le sous-mode `route-map`', async () => {
    const f = await crMensongers(['configure terminal', 'route-map RM permit 10'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 240_000);

  it('dans une liste d acces STANDARD nommee', async () => {
    const f = await crMensongers(
      ['configure terminal', 'ip access-list standard SL'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 240_000);

  it('dans une liste d acces ETENDUE nommee', async () => {
    const f = await crMensongers(
      ['configure terminal', 'ip access-list extended EL'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('sur une ligne VTY', async () => {
    const f = await crMensongers(['configure terminal', 'line vty 0 4'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('dans un processus OSPF', async () => {
    const f = await crMensongers(['configure terminal', 'router ospf 1'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('dans un processus EIGRP', async () => {
    const f = await crMensongers(['configure terminal', 'router eigrp 1'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('dans un processus BGP', async () => {
    const f = await crMensongers(['configure terminal', 'router bgp 65000'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('dans un processus RIP', async () => {
    const f = await crMensongers(['configure terminal', 'router rip'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('dans un pool DHCP', async () => {
    const f = await crMensongers(['configure terminal', 'ip dhcp pool P1'], '');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);
});

/*
 * Le balayage n'avait jamais ete promene sur un CATALYST : il ne
 * connaissait que le routeur, et douze fautes l'attendaient. Il en a
 * trouve vingt de plus en configuration d'interface, une en
 * configuration de VLAN, deux en EXEC privilegie et vingt-deux en
 * configuration globale quand on l'a enfonce d'un rang. Toutes sont
 * fermees, et les six branches d'un Catalyst comme les quatre d'un
 * routeur sont mesurees ici a quatre rangs.
 */
describe('M6 — le meme garde-fou, sur un Catalyst', () => {
  it('en configuration globale', async () => {
    const f = await crMensongers(['configure terminal'], '', CATALYST, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en EXEC privilegie, depuis la racine', async () => {
    const f = await crMensongers([], '', CATALYST, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en EXEC privilegie, branche `show`', async () => {
    const f = await crMensongers([], 'show', CATALYST);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en EXEC privilegie, branche `clear`', async () => {
    const f = await crMensongers([], 'clear', CATALYST);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en configuration d interface', async () => {
    const f = await crMensongers(
      ['configure terminal', 'interface FastEthernet0/1'], '', CATALYST, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('en configuration de VLAN', async () => {
    const f = await crMensongers(['configure terminal', 'vlan 10'], '', CATALYST, 4);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);

  it('sur la ligne console', async () => {
    const f = await crMensongers(['configure terminal', 'line con 0'], '', CATALYST);
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);
});

describe('M6 — la branche `clear` du routeur', () => {
  it('en EXEC privilegie', async () => {
    const f = await crMensongers([], 'clear');
    expect(f, f.join('\n')).toEqual([]);
  }, 480_000);
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
