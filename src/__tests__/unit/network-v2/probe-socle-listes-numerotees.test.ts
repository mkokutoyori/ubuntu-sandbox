/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS des quatre
 * commandes de configuration globale dont le premier argument est un
 * NUMERO DE LISTE.
 *
 * Ce que la reference dit :
 *   - `ip as-path access-list <1-500> {permit|deny} <expression>`
 *   - `ip community-list <1-500> {permit|deny} <communautes>`
 *     (1-99 standard, 100-500 etendue)
 *   - `priority-list <1-16> ...`
 *   - `queue-list <1-16> ...`
 *
 * Pourquoi un numero mal forme se paie : ces quatre commandes RANGENT
 * la ligne telle qu'elle a ete tapee et la rendent dans
 * `show running-config`, qui est REJOUEE a l'import d'une topologie.
 * Un numero qui n'en est pas un y revient donc tel quel, et designe une
 * liste qu'aucune autre commande ne pourra nommer.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

async function jouer(d: Cli, lignes: string[]): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, ['enable', 'configure terminal']);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, ['enable', 'configure terminal']);
  return s;
}

async function conf(d: Cli): Promise<string> {
  await jouer(d, ['end']);
  return d.executeCommand('show running-config');
}

const REFUS = /Invalid input|Incomplete command|Ambiguous command/;

interface Famille {
  readonly nom: string;
  readonly valide: string;
  readonly horsPlage: string;
  readonly nonNumerique: string;
  readonly plage: string;
}

const FAMILLES: readonly Famille[] = [
  {
    nom: 'ip as-path access-list',
    valide: 'ip as-path access-list 10 permit ^100$',
    horsPlage: 'ip as-path access-list 501 permit ^100$',
    nonNumerique: 'ip as-path access-list zorglub permit ^100$',
    plage: '<1-500>',
  },
  {
    nom: 'ip community-list',
    valide: 'ip community-list 10 permit 100:1',
    horsPlage: 'ip community-list 501 permit 100:1',
    nonNumerique: 'ip community-list zorglub permit 100:1',
    plage: '<1-500>',
  },
  {
    nom: 'priority-list',
    valide: 'priority-list 5 protocol ip high',
    horsPlage: 'priority-list 17 protocol ip high',
    nonNumerique: 'priority-list zorglub protocol ip high',
    plage: '<1-16>',
  },
  {
    nom: 'queue-list',
    valide: 'queue-list 5 protocol ip 1',
    horsPlage: 'queue-list 17 protocol ip 1',
    nonNumerique: 'queue-list zorglub protocol ip 1',
    plage: '<1-16>',
  },
];

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

for (const [plateforme, fabrique] of PLATEFORMES) {
  for (const f of FAMILLES) {
    describe(`\`${f.nom}\` sur un ${plateforme}`, () => {
      it('un numero VALIDE est accepte et se relit', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(f.valide)).not.toMatch(REFUS);
        expect(await conf(d)).toContain(f.valide);
      });

      it('un numero HORS PLAGE est refuse, pas range', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(f.horsPlage)).toMatch(REFUS);
        expect(await conf(d)).not.toContain(f.horsPlage);
      });

      it('un numero qui n est PAS un nombre est refuse, pas range', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(f.nonNumerique)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });

      it(`l aide du numero annonce ${f.plage}`, async () => {
        const d = await fabrique();
        expect(d.cliHelp(`${f.nom} `)).toContain(f.plage);
      });

      it('la commande sans numero est INCOMPLETE', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(f.nom)).toMatch(/Incomplete command/);
      });
    });
  }
}

/*
 * `ip community-list` a DEUX formes : numerotee, et NOMMEE derriere
 * `standard`/`expanded`. Le controle du numero ne doit pas juger un
 * NOM, qui est libre — sans ce cas, valider la place numerique aurait
 * refuse la moitie de la commande.
 */
describe('la forme NOMMEE de `ip community-list` reste acceptee', () => {
  for (const genre of ['standard', 'expanded'] as const) {
    it(`\`${genre}\``, async () => {
      const d = await routeur();
      const ligne = `ip community-list ${genre} MALISTE permit 100:1`;
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });
  }
});

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = FAMILLES.flatMap((f) => [f.horsPlage, f.nonNumerique, f.nom]);
  for (const saisie of SAISIES) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
      const cote = nettoie(await r.executeCommand(saisie));
      expect(cote.length).toBeGreaterThan(0);
      expect(nettoie(await s.executeCommand(saisie))).toBe(cote);
    });
  }
});
