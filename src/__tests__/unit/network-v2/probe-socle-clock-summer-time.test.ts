/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS de
 * `clock summer-time`, avant toute lecture du code.
 *
 * Ce que la reference dit :
 *   `clock summer-time <zone> recurring
 *      [<semaine> <jour> <mois> <hh:mm> <semaine> <jour> <mois> <hh:mm>
 *       [<decalage>]]`
 *   `clock summer-time <zone> date
 *      <jour> <mois> <annee> <hh:mm> <jour> <mois> <annee> <hh:mm>
 *      [<decalage>]`
 *   - la semaine est `1`-`5`, `first` ou `last` ; le jour et le mois
 *     sont des NOMS ; le decalage est en minutes.
 *   - `no clock summer-time` revient a l'heure standard.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie :
 *     une regle d'heure d'ete qui ne s'y ecrit pas est perdue, et une
 *     ligne mal formee y revient telle quelle.
 *   - un Catalyst porte la meme commande, l'IOS etant le meme.
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

const RECURRENTE = 'clock summer-time CEST recurring last Sun Mar 2:00 last Sun Oct 3:00';

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

/*
 * CE QUE CETTE SONDE N'EXIGE PAS DU COMMUTATEUR, et pourquoi : un
 * Catalyst n'a AUCUN service de gestion, donc aucune horloge a regler —
 * `clock timezone CET 1` y est accepte et `show clock` continue
 * d'annoncer UTC. C'est un manquement mesure, inscrit au `TODO.md`, et
 * il demande de donner une horloge au commutateur, ce qui depasse la
 * grammaire de cette commande. Les cas de POSE sont donc joues sur le
 * routeur seul ; les cas de REFUS, eux, valent des deux cotes, la
 * grammaire etant jugee avant le magasin.
 */
describe('la regle se pose et se relit — routeur', () => {
  it('la forme RECURRENTE complete', async () => {
    const d = await routeur();
    expect(await d.executeCommand(RECURRENTE)).not.toMatch(REFUS);
    expect(await conf(d)).toContain(RECURRENTE);
  });

  it('`recurring` seul, sans espaces en trop', async () => {
    const d = await routeur();
    expect(await d.executeCommand('clock summer-time CEST recurring'))
      .not.toMatch(REFUS);
    expect(await conf(d)).toMatch(/^clock summer-time CEST recurring$/m);
  });

  it('la forme DATEE', async () => {
    const d = await routeur();
    const datee = 'clock summer-time CEST date 25 Mar 2026 2:00 25 Oct 2026 3:00';
    expect(await d.executeCommand(datee)).not.toMatch(REFUS);
    expect(await conf(d)).toContain(datee);
  });
});

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`clock summer-time\` sur un ${nom}`, () => {
    it('un mot qui n est ni `recurring` ni `date` est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('clock summer-time CEST zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('une regle RECURRENTE mal formee est refusee, pas rangee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('clock summer-time CEST recurring zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('un MOIS qui n existe pas est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'clock summer-time CEST recurring last Sun Zorglub 2:00 last Sun Oct 3:00'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/Zorglub/);
    });

    it('une HEURE qui n en est pas une est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'clock summer-time CEST recurring last Sun Mar 99:99 last Sun Oct 3:00'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/99:99/);
    });

    it('`no clock summer-time` est accepte', async () => {
      const d = await fabrique();
      await d.executeCommand(RECURRENTE);
      expect(await d.executeCommand('no clock summer-time')).not.toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/^clock summer-time/m);
    });

    it('la commande sans zone est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('clock summer-time'))
        .toMatch(/Incomplete command/);
    });

    it('l aide apres la zone annonce `recurring` et `date`', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('clock summer-time CEST ');
      expect(aide).toMatch(/^\s+recurring\b/m);
      expect(aide).toMatch(/^\s+date\b/m);
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'clock summer-time CEST zorglub',
    'clock summer-time CEST recurring zorglub',
    'clock summer-time CEST recurring last Sun Zorglub 2:00 last Sun Oct 3:00',
    'clock summer-time',
  ];
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
