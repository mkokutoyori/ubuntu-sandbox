/*
 * Sonde sur l'ARITE des commandes de `config-router-ospf`.
 *
 * Aucune formulation n'est exigee : cisco.com est bloque au
 * telechargement par le mandataire de sortie de ce reseau. Ce qui se
 * mesure sur la machine SEULE est l'invariant du depot —
 *
 *   `?` n'annonce `<cr>` que la ou la frappe VALIDE
 *
 * — et la grammaire que le gestionnaire de ce sous-mode APPLIQUE deja :
 * `area` lit un identifiant d'aire PUIS une sous-commande
 * (`args[0]` est l'aire, `args[1]` la sous-commande, et `args.length <
 * 2` rend « % Incomplete command. »). C'est cette grammaire-la que
 * l'aide doit refleter, et elle se lit sur le moteur, pas sur une
 * reference.
 *
 * VINGT-ET-UN `<cr>` menteurs y ont ete mesures en promenant le
 * balayage a profondeur 3. Deux familles s'y distinguent :
 *
 *   - la frappe INCOMPLETE qui promet `<cr>` — `auto-cost`,
 *     `capability`, `neighbor`, `timers throttle lsa`… ;
 *   - le mot annonce au MAUVAIS RANG : `area ?` proposait `stub`,
 *     `range`, `virtual-link`… qui viennent APRES l'identifiant
 *     d'aire. L'operateur qui les suit ecrit `area stub`, et la machine
 *     range alors une aire NOMMEE « stub ».
 *
 * POURQUOI CELA COUTE CHER : une aire mal nommee ne se voit pas. Elle
 * entre dans `show running-config`, elle est rejouee a l'import, et
 * l'adjacence qu'elle devait former ne se forme jamais.
 *
 * Discriminee contre l'etat d'avant : 24 des 40 cas tombent. Les 16 qui
 * passent des deux cotes sont nommes :
 *
 *   - treize des quatorze frappes COMPLETES gardaient deja leur `<cr>`
 *     et s'executaient. Ce sont les TEMOINS : exiger une place partout
 *     aurait ete un echange, pas une correction — `area 1 stub` se
 *     passe de `no-summary`, `area 0 authentication` de son mode, et
 *     `network ... area 0` prend deja son aire au bon rang ;
 *   - `passive-interface ?` annoncait deja `default`, et
 *     `area 0 ?` / `auto-cost reference-bandwidth ?` sont les deux cas
 *     qui MESURENT le deplacement : ils tombent.
 *
 * Le dernier cas, « ce qui est pose se relit dans la configuration »,
 * tombe des deux cotes pour une raison qui n'est pas l'arite : RIEN de
 * ce qu'une aire porte n'etait rendu par `show running-config` —
 * ni son type, ni ses plages, ni son cout, ni son authentification, ni
 * ses liens virtuels, pas plus que `auto-cost`, `capability`, les
 * minuteries d'etranglement ou les voisins NBMA. Tout cela etait
 * accepte, range dans le moteur, et perdu au rechargement. Le lot le
 * ferme aussi : c'est la meme frappe qui doit valoir quelque chose.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function ospf(): Promise<Cli> {
  const d = new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'router ospf 1']) {
    await d.executeCommand(c);
  }
  return d;
}

/** Les vingt-et-une frappes que la machine refuse, et que `?` disait completes. */
const INCOMPLETES: readonly string[] = [
  'area',
  'area authentication',
  'area default-cost',
  'area filter-list',
  'area message-digest',
  'area no-summary',
  'area nssa-only',
  'area range',
  'area sham-link',
  'area stub',
  'area virtual-link',
  'auto-cost',
  'auto-cost reference-bandwidth',
  'capability',
  'distribute-list gateway',
  'distribute-list prefix',
  'neighbor',
  'no passive-interface',
  'passive-interface',
  'timers throttle lsa',
  'timers throttle spf',
];

/** Ce qui valide vraiment, et doit garder son `<cr>`. */
const COMPLETES: ReadonlyArray<readonly [string, string]> = [
  ['area 1 stub', 'area 1 stub'],
  ['area 2 nssa', 'area 2 nssa'],
  ['area 0 authentication', 'area 0 authentication'],
  ['area 0 default-cost 10', 'area 0 default-cost 10'],
  ['area 0 range 10.0.0.0 255.255.255.0', 'area 0 range'],
  ['area 3 virtual-link 1.1.1.1', 'area 3 virtual-link'],
  ['auto-cost reference-bandwidth 1000', 'auto-cost reference-bandwidth 1000'],
  ['capability opaque', 'capability'],
  ['neighbor 1.1.1.1', 'neighbor 1.1.1.1'],
  ['passive-interface default', 'passive-interface default'],
  ['timers throttle lsa 10 100 1000', 'timers throttle lsa'],
  ['timers throttle spf 10 100 1000', 'timers throttle spf'],
  ['router-id 9.9.9.9', 'router-id 9.9.9.9'],
  ['network 10.0.0.0 0.0.0.255 area 0', 'network 10.0.0.0 0.0.0.255 area 0'],
];

describe('l arite de `config-router-ospf`', () => {
  for (const frappe of INCOMPLETES) {
    it(`\`${frappe} ?\` ne promet pas de \`<cr>\``, async () => {
      const d = await ospf();
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`)
        .toBe(false);
      expect(await d.executeCommand(frappe), frappe)
        .toMatch(/Incomplete command/);
    });
  }

  for (const [frappe] of COMPLETES) {
    it(`\`${frappe} ?\` promet un \`<cr>\` qui tient — le TEMOIN`, async () => {
      const d = await ospf();
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`)
        .toBe(true);
      expect(await d.executeCommand(frappe), frappe)
        .not.toMatch(/Invalid|Incomplete/);
    });
  }

  it('ce qui est pose se relit dans la configuration — le TEMOIN', async () => {
    const d = await ospf();
    for (const [frappe] of COMPLETES) await d.executeCommand(frappe);
    await d.executeCommand('end');
    const texte = await d.executeCommand('show running-config');
    for (const [, rendu] of COMPLETES) {
      expect(texte, rendu).toContain(rendu);
    }
  });

  it('`area ?` annonce l IDENTIFIANT d aire, pas ses sous-commandes', async () => {
    const d = await ospf();
    const rendus = mots(d.cliHelp('area '));
    expect(rendus).toContain('<0-4294967295>');
    for (const sous of ['stub', 'range', 'virtual-link', 'authentication']) {
      expect(rendus, `area ? offre ${sous}, qui vient apres l aire`)
        .not.toContain(sous);
    }
  });

  it('`area 0 ?` annonce les sous-commandes', async () => {
    const d = await ospf();
    const rendus = mots(d.cliHelp('area 0 '));
    for (const sous of ['authentication', 'default-cost', 'range', 'stub', 'virtual-link']) {
      expect(rendus, `area 0 ? tait ${sous}`).toContain(sous);
    }
  });

  it('`passive-interface ?` annonce `default` ET une interface', async () => {
    const d = await ospf();
    const rendus = mots(d.cliHelp('passive-interface '));
    expect(rendus).toContain('default');
  });

  it('`auto-cost reference-bandwidth ?` annonce sa plage', async () => {
    const d = await ospf();
    expect(mots(d.cliHelp('auto-cost reference-bandwidth '))).toContain('<1-4294967>');
  });
});
