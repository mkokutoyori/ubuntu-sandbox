/**
 * PRD-CLI-Fidelite-VRP.md §17 / lot V8 — la grammaire de `acl` et `stp`.
 *
 * Trois proprietes, chacune tombee d'une mesure :
 *
 * 1. UNE SEULE GRAMMAIRE D'`acl`. Il y en avait deux, et elles ne
 *    disaient pas la meme chose : le switch n'avait aucune borne et
 *    ouvrait une vue nommee `NaN`. Le balayage compare les DEUX
 *    plateformes sur la meme ligne, ce qui est plus fort que de verifier
 *    chacune contre une attente ecrite a la main.
 * 2. `stp` EST UNE TABLE, pas un premier mot suivi du vide. Ce qui suit
 *    le mot-cle est verifie, et un refus ne pose rien.
 * 3. LE CURSEUR DESIGNE LE MOT FAUTIF. Il se posait sur le mot-cle que
 *    l'operateur avait juste.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { STP_SYSTEME, STP_INTERFACE, analyserStp } from '@/network/devices/shells/huawei/HuaweiStpGrammar';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string>; getPrompt(): string }

async function dans(kind: 'R' | 'S', vue: readonly string[]): Promise<Cli> {
  const d = (kind === 'R'
    ? new HuaweiRouter(`G${++serie}`)
    : new HuaweiSwitch('switch-huawei', `G${++serie}`)) as unknown as Cli;
  for (const c of vue) await d.executeCommand(c);
  return d;
}

const REFUS = /^Error: (Wrong parameter|Incomplete command|Unrecognized command|Too many parameters) found at '\^' position\./;

/** La vue ouverte, sans le nom de la machine qui differe d'un cas a l'autre. */
const vueOuverte = (c: Cli) => c.getPrompt().replace(/^\[[^-\]]+/, '[');

// ── 1. Une seule grammaire d'`acl` ────────────────────────────────

const ACL_FORMES = [
  'acl 2000', 'acl 3000', 'acl 2999', 'acl 3999',
  'acl number 2000', 'acl number 3000',
  'acl name TEST', 'acl name TEST basic', 'acl name TEST advance',
  'acl name TEST 2999', 'acl name TEST 3001',
  'acl ipv6 name V6',
  'acl 1999', 'acl 4000', 'acl 42', 'acl 0', 'acl abc',
  'acl', 'acl number', 'acl name', 'acl ipv6', 'acl ipv6 name',
  'acl 2000 extra', 'acl number 2000 extra', 'acl name TEST advance extra',
  'acl name TEST zzz', 'acl ipv6 name V6 extra', 'acl ipv6 zzz name V6',
];

describe('`acl` : une seule grammaire pour les deux plateformes', () => {
  it('routeur et switch repondent la MEME chose a chaque forme', async () => {
    for (const forme of ACL_FORMES) {
      const r = await dans('R', ['system-view']);
      const s = await dans('S', ['system-view']);
      const outR = await r.executeCommand(forme);
      const outS = await s.executeCommand(forme);
      expect(outS, forme).toBe(outR);
      expect(vueOuverte(s), `vue apres ${forme}`).toBe(vueOuverte(r));
    }
  });

  it('un numero hors des bornes tenues est refuse, des deux cotes', async () => {
    for (const plat of ['R', 'S'] as const) {
      for (const n of ['0', '42', '1999', '4000', '5000']) {
        const d = await dans(plat, ['system-view']);
        expect(await d.executeCommand(`acl ${n}`), `${plat} acl ${n}`)
          .toContain('ACL number must be');
        expect(vueOuverte(d), `${plat} acl ${n}`).not.toContain('acl');
      }
    }
  });

  it('aucune vue ne s\'ouvre sur un nom qui n\'en est pas un', async () => {
    for (const plat of ['R', 'S'] as const) {
      for (const forme of ['acl abc', 'acl number', 'acl name TEST zzz']) {
        const d = await dans(plat, ['system-view']);
        await d.executeCommand(forme);
        expect(d.getPrompt(), `${plat} ${forme}`).not.toContain('NaN');
        expect(d.getPrompt(), `${plat} ${forme}`).not.toContain('acl');
      }
    }
  });

  it('le type d\'une ACL nommee suit ce qui est ecrit, des deux cotes', async () => {
    for (const [forme, attendu] of [
      ['acl name TEST advance', 'acl-adv-TEST'],
      ['acl name TEST basic', 'acl-basic-TEST'],
      ['acl name TEST 3001', 'acl-adv-TEST'],
      ['acl name TEST 2999', 'acl-basic-TEST'],
      ['acl ipv6 name V6', 'acl-adv-V6'],
    ] as const) {
      for (const plat of ['R', 'S'] as const) {
        const d = await dans(plat, ['system-view']);
        expect(await d.executeCommand(forme), `${plat} ${forme}`).toBe('');
        expect(d.getPrompt(), `${plat} ${forme}`).toContain(attendu);
      }
    }
  });

  it('une regle se pose toujours dans la vue ouverte', async () => {
    for (const plat of ['R', 'S'] as const) {
      const d = await dans(plat, ['system-view', 'acl 2000']);
      expect(await d.executeCommand('rule permit source 10.0.0.0 0.0.0.255'), plat)
        .not.toMatch(REFUS);
    }
  });
});

// ── 2. `stp` est une table ────────────────────────────────────────

const STP_SYS_LEGITIMES = [
  'stp enable', 'stp disable', 'stp mode stp', 'stp mode rstp', 'stp mode mstp',
  'stp priority 0', 'stp priority 4096', 'stp priority 61440',
  'stp root primary', 'stp root secondary',
  'stp instance 1 priority 4096', 'stp bpdu-protection', 'stp edged-port default',
  'stp pathcost-standard dot1t', 'stp pathcost-standard dot1d-1998',
  'stp tc-protection', 'stp converge fast',
  'stp timer hello 200', 'stp timer forward-delay 1500', 'stp timer max-age 2000',
  'stp region-configuration',
];

const STP_SYS_REFUSES = [
  'stp', 'stp zzz', 'stp mode', 'stp mode zzz',
  'stp priority', 'stp priority abc', 'stp priority 5000', 'stp priority 61441',
  'stp root', 'stp root zzz', 'stp edged-port', 'stp edged-port zzz',
  'stp pathcost-standard zzz', 'stp converge zzz',
  'stp timer hello', 'stp timer zzz 200', 'stp timer hello 50', 'stp timer hello 99999',
  'stp instance 1', 'stp instance 1 zzz 4096', 'stp instance 1 priority 5000',
  'stp mode rstp extra', 'stp priority 4096 extra', 'stp root primary extra',
  'stp enable extra', 'stp bpdu-protection extra', 'stp edged-port default extra',
  'stp instance 1 priority 4096 extra', 'stp region-configuration extra',
];

const STP_IF_LEGITIMES = [
  'stp enable', 'stp disable',
  'stp edged-port enable', 'stp edged-port disable',
  'stp bpdu-protection enable', 'stp bpdu-filter enable',
  'stp cost 200', 'stp instance 1 cost 200', 'stp port priority 32',
  'stp root-protection', 'stp loop-protection', 'stp tc-restriction',
];

const STP_IF_REFUSES = [
  'stp zzz', 'stp edged-port', 'stp edged-port zzz', 'stp cost', 'stp cost abc',
  'stp port', 'stp port priority', 'stp port priority abc', 'stp port priority 33',
  'stp instance 1', 'stp instance 1 zzz 200',
  'stp edged-port enable extra', 'stp cost 200 extra', 'stp root-protection extra',
];

describe('`stp` : ce qui suit le mot-cle est verifie', () => {
  it('vue systeme — les formes legitimes passent', async () => {
    for (const forme of STP_SYS_LEGITIMES) {
      const s = await dans('S', ['system-view']);
      expect(await s.executeCommand(forme), forme).not.toMatch(REFUS);
    }
  });

  it('vue systeme — les formes fautives sont refusees', async () => {
    for (const forme of STP_SYS_REFUSES) {
      const s = await dans('S', ['system-view']);
      expect(await s.executeCommand(forme), forme).toMatch(REFUS);
    }
  });

  it('vue interface — les formes legitimes passent', async () => {
    for (const forme of STP_IF_LEGITIMES) {
      const s = await dans('S', ['system-view', 'interface GigabitEthernet0/0/1']);
      expect(await s.executeCommand(forme), forme).not.toMatch(REFUS);
    }
  });

  it('vue interface — les formes fautives sont refusees', async () => {
    for (const forme of STP_IF_REFUSES) {
      const s = await dans('S', ['system-view', 'interface GigabitEthernet0/0/1']);
      expect(await s.executeCommand(forme), forme).toMatch(REFUS);
    }
  });

  it('un refus ne change pas le mode', async () => {
    const s = await dans('S', ['system-view', 'stp mode rstp']);
    expect(await s.executeCommand('stp mode mstp extra')).toMatch(REFUS);
    await s.executeCommand('quit');
    expect(await s.executeCommand('display stp')).toContain('Mode RSTP');
  });

  it('un refus en vue interface ne laisse pas sa ligne dans la configuration', async () => {
    const s = await dans('S', ['system-view', 'interface GigabitEthernet0/0/1']);
    await s.executeCommand('stp cost abc');
    await s.executeCommand('stp edged-port zzz');
    const vue = await s.executeCommand('display this');
    expect(vue).not.toContain('abc');
    expect(vue).not.toContain('zzz');
  });

  it('une forme admise, elle, reste dans la configuration', async () => {
    const s = await dans('S', ['system-view', 'interface GigabitEthernet0/0/1']);
    expect(await s.executeCommand('stp edged-port enable')).toBe('');
    expect(await s.executeCommand('display this')).toContain('stp edged-port enable');
  });

  it('`stp` n\'existe pas sur un routeur, et le refus le dit', async () => {
    for (const forme of ['stp enable', 'stp mode rstp', 'stp zzz']) {
      const r = await dans('R', ['system-view']);
      expect(await r.executeCommand(forme), forme).toMatch(REFUS);
    }
  });
});

describe('`stp` : ce qui etait jete est desormais applique', () => {
  it('`stp timer` atteint le moteur, en convertissant les centiemes', async () => {
    // La reference est mesuree dans le meme laboratoire : sans elle,
    // un laboratoire mal monte et une commande sans effet seraient
    // indiscernables. Le defaut de VRP est Hello 2s.
    const temoin = await dans('S', ['system-view', 'quit']);
    expect(await temoin.executeCommand('display stp')).toContain('Hello 2s');

    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('stp timer hello 500')).toBe('');
    await s.executeCommand('quit');
    const vue = await s.executeCommand('display stp');
    expect(vue).toContain('Hello 5s');
    expect(vue).not.toContain('Hello 2s');
  });

  it('les trois temporisateurs sont convertis, pas seulement le premier', async () => {
    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('stp timer forward-delay 2000')).toBe('');
    expect(await s.executeCommand('stp timer max-age 3000')).toBe('');
    await s.executeCommand('quit');
    const vue = await s.executeCommand('display stp');
    expect(vue).toContain('MaxAge 30s');
    expect(vue).toContain('FwDly 20s');
  });

  it('`stp pathcost-standard` aussi', async () => {
    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('stp pathcost-standard dot1t')).toBe('');
    expect(await s.executeCommand('stp pathcost-standard dot1d-1998')).toBe('');
  });
});

// ── 3. Le curseur designe le mot fautif ───────────────────────────

describe('le curseur designe le mot fautif', () => {
  const CIBLES: ReadonlyArray<readonly ['R' | 'S', string[], string, string]> = [
    ['S', ['system-view'], 'stp mode zzz', 'zzz'],
    ['S', ['system-view'], 'stp priority 5000', '5000'],
    ['S', ['system-view'], 'stp root zzz', 'zzz'],
    ['S', ['system-view'], 'stp mode rstp extra', 'extra'],
    ['S', ['system-view'], 'stp timer hello 50', '50'],
    ['S', ['system-view'], 'stp instance 1 priority 5000', '5000'],
    ['S', ['system-view', 'interface GigabitEthernet0/0/1'], 'stp cost abc', 'abc'],
    ['S', ['system-view', 'interface GigabitEthernet0/0/1'], 'stp port priority 33', '33'],
    ['R', ['system-view'], 'acl name TEST zzz', 'zzz'],
    ['R', ['system-view'], 'acl 2000 extra', 'extra'],
    ['S', ['system-view'], 'acl name TEST zzz', 'zzz'],
    ['S', ['system-view'], 'acl number 2000 extra', 'extra'],
  ];

  it.each(CIBLES)('%s %j %s -> ^ sous %s', async (plat, vue, forme, mot) => {
    const d = await dans(plat, vue);
    const lignes = (await d.executeCommand(forme)).split('\n');
    expect(lignes.length, forme).toBe(3);
    expect(lignes[1]).toBe(forme);
    expect(lignes[2].indexOf('^'), `${forme} : ^ attendu sous "${mot}"`)
      .toBe(forme.indexOf(mot));
  });
});

// ── La table elle-meme ────────────────────────────────────────────

describe('la table est la grammaire, et rien ne la contourne', () => {
  it('chaque mot-cle declare est accepte dans sa vue', () => {
    for (const [table, exemple] of [
      [STP_SYSTEME, { mode: ['rstp'], priority: ['4096'], root: ['primary'] }],
      [STP_INTERFACE, { cost: ['200'], 'edged-port': ['enable'] }],
    ] as const) {
      for (const regle of table) {
        // Un mot-cle a arite nulle doit passer seul ; les autres sont
        // couverts par les balayages ci-dessus.
        const r = analyserStp([regle.mot, ...(exemple[regle.mot as keyof typeof exemple] ?? [])], table);
        if (r.statut === 'refus') {
          expect(r.err.kind, `${regle.mot} : refus inattendu`).toBe('incomplete');
        }
      }
    }
  });

  it('un mot-cle absent de la table est INCONNU, pas « mauvais parametre »', () => {
    const r = analyserStp(['zzz'], STP_SYSTEME);
    expect(r.statut).toBe('refus');
    if (r.statut === 'refus') expect(r.err.kind).toBe('unrecognized');
  });

  it('une valeur hors bornes est un MAUVAIS PARAMETRE, pas un mot inconnu', () => {
    const r = analyserStp(['priority', '5000'], STP_SYSTEME);
    expect(r.statut).toBe('refus');
    if (r.statut === 'refus') expect(r.err.kind).toBe('wrong');
  });
});

describe('ce que ce lot ne traite pas, et le dit', () => {
  it('`tc-protection` et `converge` sont admis et ne font rien', async () => {
    // Leur grammaire est desormais verifiee, mais aucun modele ne les
    // porte : il n'y a ni limitation de debit des changements de
    // topologie ni convergence rapide dans ce simulateur. Les refuser
    // serait faux — ce sont de vraies commandes VRP — et pretendre
    // qu'elles agissent le serait aussi.
    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('stp tc-protection')).toBe('');
    expect(await s.executeCommand('stp converge fast')).toBe('');
  });

  it('les ACL L2 et utilisateur de VRP restent hors des bornes tenues', async () => {
    // 4000-4999 (L2) et 5000-5999 (utilisateur) existent sur VRP ; rien
    // ici ne sait evaluer une regle de ces familles, donc la vue n'est
    // pas ouverte et la borne tenue est nommee.
    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('acl 4000')).toContain('ACL number must be');
    expect(await s.executeCommand('acl 5000')).toContain('ACL number must be');
  });
});
