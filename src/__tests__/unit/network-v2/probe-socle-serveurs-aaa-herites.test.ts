/*
 * UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE et la mesure l'a corrigee
 * plutot que le code : j'avais ecrit la forme valide de TACACS+ avec
 * `port 49 timeout 5`, puis exige de la relire telle quelle. Ce sont
 * les DEFAUTS d'IOS, et IOS n'ecrit pas ses defauts — ce depot non
 * plus, c'est meme la regle que plusieurs lots ont fait appliquer. Le
 * cas emploie donc des valeurs qui ne sont pas les defauts, sans quoi
 * il exigeait le contraire de ce que la machine doit faire.
 *
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS des formes
 * HERITEES de declaration de serveur AAA, avant toute lecture du code.
 *
 * Ce que la reference dit :
 *   `radius-server host <ip> [auth-port <0-65535>] [acct-port <0-65535>]
 *      [timeout <1-1000>] [retransmit <0-100>] [key <chaine>]`
 *   `tacacs-server host <ip> [port <1-65535>] [timeout <1-1000>]
 *      [key <chaine>]`
 *
 * Ces deux formes sont les plus tapees de tous les cours, et le
 * `CLAUDE.md` rappelle qu'elles alimentent DESORMAIS le vrai magasin :
 * un port ou un delai mal forme y entre donc pour de bon, part dans la
 * configuration — rejouee a l'import d'une topologie — et decrit un
 * serveur que la machine ne pourra pas joindre.
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

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

interface Cas {
  readonly nom: string;
  readonly valide: string;
  readonly mauvais: readonly string[];
}

const CAS: readonly Cas[] = [
  {
    nom: 'radius-server host',
    valide: 'radius-server host 10.0.0.1 auth-port 1812 acct-port 1813 key S3cret',
    mauvais: [
      'radius-server host 10.0.0.1 auth-port zorglub',
      'radius-server host 10.0.0.1 auth-port 99999',
      'radius-server host 10.0.0.1 acct-port zorglub',
      'radius-server host 10.0.0.1 timeout zorglub',
      'radius-server host 10.0.0.1 retransmit zorglub',
    ],
  },
  {
    nom: 'tacacs-server host',
    valide: 'tacacs-server host 10.0.0.2 port 4949 timeout 7 key S3cret',
    mauvais: [
      'tacacs-server host 10.0.0.2 port zorglub',
      'tacacs-server host 10.0.0.2 port 99999',
      'tacacs-server host 10.0.0.2 timeout zorglub',
    ],
  },
];

for (const [plateforme, fabrique] of PLATEFORMES) {
  for (const cas of CAS) {
    describe(`\`${cas.nom}\` sur un ${plateforme}`, () => {
      it('la forme VALIDE se pose et se relit', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(cas.valide)).not.toMatch(REFUS);
        expect(await conf(d)).toContain(cas.valide);
      });

      for (const saisie of cas.mauvais) {
        it(`\`${saisie}\` est refuse, pas range`, async () => {
          const d = await fabrique();
          expect(await d.executeCommand(saisie)).toMatch(REFUS);
          const texte = await conf(d);
          expect(texte).not.toMatch(/zorglub/);
          expect(texte).not.toMatch(/99999/);
          expect(texte).not.toMatch(/NaN/);
        });
      }

      it('une adresse malformee est refusee', async () => {
        const d = await fabrique();
        const mot = cas.nom.startsWith('radius') ? 'radius-server' : 'tacacs-server';
        expect(await d.executeCommand(`${mot} host 999.1.1.1`)).toMatch(REFUS);
      });

      it('un mot-cle INCONNU est refuse, pas avale', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${cas.nom} 10.0.0.9 zorglub 5`))
          .toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });
    });
  }
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = CAS.flatMap((c) => [...c.mauvais, `${c.nom} 10.0.0.9 zorglub 5`]);
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
