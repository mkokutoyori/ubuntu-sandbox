/*
 * UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE et la mesure l'a corrigee
 * plutot que le code : j'avais lu `ip ssh version 2` comme INERTE parce
 * qu'il ne paraissait ni dans la configuration ni dans `show ip ssh`.
 * Un vrai IOS le REFUSE tant qu'aucune cle RSA n'existe — « Please
 * create RSA keys (of at least 768 bits size) to enable SSH v2. » — et
 * ce simulateur le refuse pareil. Le laboratoire genere donc les cles,
 * ce qu'un operateur fait de toute facon avant de parler de SSH.
 *
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS d'`ip ssh` et
 * d'`ip scp server`, avant toute lecture du code.
 *
 * Ce que la reference dit :
 *   - `ip ssh version {1 | 2}` — sans elle, IOS annonce `1.99`,
 *     c'est-a-dire « les deux versions acceptees » ; c'est ainsi qu'un
 *     operateur voit que `ip ssh version 2` manque.
 *   - `ip ssh time-out <1-120>` — le delai de NEGOCIATION, en secondes.
 *   - `ip ssh authentication-retries <0-5>`.
 *   - chacune a une forme en `no`, qui rend le defaut.
 *   - `ip scp server enable` — le serveur SCP, qui s'appuie sur SSH.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie :
 *     une valeur qu'on y ecrit revient telle quelle au rechargement.
 *   - un Catalyst porte les memes commandes, l'IOS etant le meme.
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

const AMORCE = [
  'enable', 'configure terminal', 'ip domain-name lab.local',
  'crypto key generate rsa modulus 768',
];

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli;
  r.powerOn();
  await jouer(r, AMORCE);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0) as unknown as Cli;
  s.powerOn();
  await jouer(s, AMORCE);
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

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`ip ssh\` sur un ${nom}`, () => {
    it('la VERSION se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh version 2')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^ip ssh version 2\s*$/m);
    });

    it('et `show ip ssh` annonce la meme version', async () => {
      const d = await fabrique();
      await d.executeCommand('ip ssh version 2');
      await jouer(d, ['end']);
      expect(await d.executeCommand('show ip ssh')).toContain('2.0');
    });

    it('sans commande, la version annoncee est 1.99 — les DEUX', async () => {
      const d = await fabrique();
      await jouer(d, ['end']);
      expect(await d.executeCommand('show ip ssh')).toContain('1.99');
    });

    it('une version qui n existe pas est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh version 3')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/ip ssh version 3/);
    });

    it('le DELAI se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh time-out 45')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^ip ssh time-out 45\s*$/m);
    });

    it('le delai est borne a 1-120', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh time-out 121')).toMatch(REFUS);
      expect(await d.executeCommand('ip ssh time-out 0')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/time-out (121|0)\b/);
    });

    it('les REESSAIS se posent et se relisent', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh authentication-retries 5'))
        .not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^ip ssh authentication-retries 5\s*$/m);
    });

    it('les reessais sont bornes a 0-5', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh authentication-retries 6'))
        .toMatch(REFUS);
      expect(await d.executeCommand('ip ssh authentication-retries -1'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/authentication-retries (6|-1)\b/);
    });

    /*
     * Le coeur de la sonde. Un jeton qui n'est pas un nombre traversait
     * `parseInt` et ce qu'il en reste — `NaN`, un mot de JavaScript —
     * etait RANGE, rendu par `show ip ssh` et ECRIT dans la
     * configuration, que l'import d'une topologie rejoue. Pire qu'une
     * acceptation muette : la valeur VALIDE d'avant etait perdue.
     */
    it('un delai qui n est pas un nombre est refuse, et ne casse rien', async () => {
      const d = await fabrique();
      await d.executeCommand('ip ssh time-out 45');
      expect(await d.executeCommand('ip ssh time-out zorglub')).toMatch(REFUS);
      const texte = await conf(d);
      expect(texte).not.toMatch(/NaN/);
      expect(texte).toMatch(/^ip ssh time-out 45\s*$/m);
    });

    it('des reessais qui ne sont pas un nombre sont refuses, et ne cassent rien',
      async () => {
        const d = await fabrique();
        await d.executeCommand('ip ssh authentication-retries 4');
        expect(await d.executeCommand('ip ssh authentication-retries zorglub'))
          .toMatch(REFUS);
        const texte = await conf(d);
        expect(texte).not.toMatch(/NaN/);
        expect(texte).toMatch(/^ip ssh authentication-retries 4\s*$/m);
      });

    it('`show ip ssh` n annonce jamais NaN', async () => {
      const d = await fabrique();
      await d.executeCommand('ip ssh time-out zorglub');
      await d.executeCommand('ip ssh authentication-retries zorglub');
      await jouer(d, ['end']);
      expect(await d.executeCommand('show ip ssh')).not.toMatch(/NaN/);
    });

    /*
     * Le curseur MONTRE ou l'on s'est trompe, et le mot vise ici est la
     * valeur, pas le mot-cle qui la precede.
     */
    it('le curseur pointe la VALEUR refusee, pas le mot-cle', async () => {
      const d = await fabrique();
      const saisie = 'ip ssh time-out zorglub';
      const sortie = await d.executeCommand(saisie);
      const ligne = sortie.split('\n').find((l) => l.includes('^')) ?? '';
      const invite = ligne.length - ligne.trimStart().length - saisie.indexOf('zorglub');
      expect(invite).toBeGreaterThanOrEqual(0);
      expect(ligne.indexOf('^') - invite).toBe(saisie.indexOf('zorglub'));
    });

    it('`ip ssh` seul est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh')).toMatch(/Incomplete command/);
    });

    it('un mot-cle INCONNU est refuse, pas avale', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh zorglub 5')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('`no ip ssh time-out` rend le defaut', async () => {
      const d = await fabrique();
      await d.executeCommand('ip ssh time-out 45');
      expect(await d.executeCommand('no ip ssh time-out')).not.toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/^ip ssh time-out/m);
    });

    it('`no ip ssh version` rend le defaut', async () => {
      const d = await fabrique();
      await d.executeCommand('ip ssh version 2');
      expect(await d.executeCommand('no ip ssh version')).not.toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/^ip ssh version/m);
    });

    it('`server algorithm` se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh server algorithm mac hmac-sha2-256'))
        .not.toMatch(REFUS);
      expect(await conf(d))
        .toMatch(/^ip ssh server algorithm mac hmac-sha2-256\s*$/m);
    });

    it('une FAMILLE d algorithmes inconnue est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh server algorithm zorglub aes'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('`dh min size` se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip ssh dh min size 2048')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^ip ssh dh min size 2048\s*$/m);
    });

    it('l aide annonce les sous-commandes', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('ip ssh ');
      expect(aide).toMatch(/^\s+version\b/m);
      expect(aide).toMatch(/^\s+time-out\b/m);
      expect(aide).toMatch(/^\s+authentication-retries\b/m);
    });

    it('l aide du DELAI annonce <1-120>', async () => {
      const d = await fabrique();
      expect(d.cliHelp('ip ssh time-out ')).toContain('<1-120>');
    });

    it('l aide des REESSAIS annonce <0-5>', async () => {
      const d = await fabrique();
      expect(d.cliHelp('ip ssh authentication-retries ')).toContain('<0-5>');
    });

    it('l aide de la VERSION annonce 1 et 2, pas les commandes voisines',
      async () => {
        const d = await fabrique();
        const aide = d.cliHelp('ip ssh version ');
        expect(aide).toMatch(/^\s+1\b/m);
        expect(aide).toMatch(/^\s+2\b/m);
        expect(aide).not.toMatch(/time-out/);
      });
  });

  describe(`\`ip scp server\` sur un ${nom}`, () => {
    it('le serveur SCP se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip scp server enable')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^ip scp server enable\s*$/m);
    });

    it('`no ip scp server enable` le retire', async () => {
      const d = await fabrique();
      await d.executeCommand('ip scp server enable');
      await d.executeCommand('no ip scp server enable');
      expect(await conf(d)).not.toMatch(/^ip scp server enable/m);
    });

    it('un mot-cle inconnu apres `ip scp` est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip scp zorglub')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('l aide apres `ip scp server` annonce `enable`, pas un mot libre',
      async () => {
        const d = await fabrique();
        const aide = d.cliHelp('ip scp server ');
        expect(aide).toMatch(/^\s+enable\b/m);
        expect(aide).not.toMatch(/WORD/);
      });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'ip ssh version 3',
    'ip ssh time-out 121',
    'ip ssh time-out zorglub',
    'ip ssh authentication-retries 6',
    'ip ssh',
    'ip ssh zorglub 5',
    'ip scp zorglub',
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

  it('les lignes de configuration sont ECRITES PAREIL', async () => {
    const r = await routeur(); const s = await commutateur();
    const poser = ['ip ssh version 2', 'ip ssh time-out 45',
      'ip ssh authentication-retries 4', 'ip scp server enable'];
    for (const c of poser) { await r.executeCommand(c); await s.executeCommand(c); }
    const lignes = (t: string) =>
      t.split('\n').filter((l) => /^ip (ssh|scp)\b/.test(l)).join('\n');
    expect(lignes(await conf(s))).toBe(lignes(await conf(r)));
  });
});
