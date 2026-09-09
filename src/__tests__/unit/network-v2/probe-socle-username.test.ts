/*
 * TROIS PREMISSES DE CETTE SONDE ETAIENT FAUSSES et la mesure les a
 * corrigees plutot que le code :
 *   - `bob` est un compte SEEDE de ce simulateur, si bien qu'une
 *     commande REFUSEE semblait le creer alors qu'il etait deja la ;
 *     les cas emploient `zoe`, un nom que rien ne pose.
 *   - `algorithm-type` et un condense DEJA calcule etaient tous deux
 *     honores ; mes expressions ne mordaient pas parce qu'elles
 *     oubliaient le `privilege 1` que le rendu intercalait.
 *   - `username <nom>` SEUL est accepte, et rien d'atteignable
 *     n'atteste qu'un vrai IOS le refuse : le cas ne l'exige donc plus.
 *
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS de `username`,
 * la commande qui declare un compte local — donc celle dont une
 * acceptation trop large se paie en acces.
 *
 * Ce que la reference dit :
 *   - `username <nom> password <mot>` et `username <nom> secret <mot>`
 *     posent le secret ; `secret` le range condense, `password` en
 *     clair sauf `service password-encryption`.
 *   - `privilege <niveau>` prend 0-15, et RIEN d'autre : c'est le
 *     niveau d'EXEC auquel le compte entre.
 *   - `algorithm-type { md5 | sha256 | scrypt } secret <mot>` choisit
 *     le condense.
 *   - un chiffre explicite (`secret 5 <condense>`) decrit un condense
 *     DEJA calcule et ne doit pas etre recondense.
 *   - `nopassword` declare un compte sans secret.
 *   - `no username <nom>` supprime le compte.
 *   - la configuration rendue est REJOUEE a l'import d'une topologie :
 *     un compte qui n'y parait pas disparait, et un niveau qui s'y perd
 *     rend le compte plus ou moins puissant qu'il n'etait.
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

const REFUS = /Invalid input|Incomplete command|Ambiguous command|out of range/;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`username\` sur un ${nom}`, () => {
    it('un compte se declare et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username bob secret Cisco123')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^username bob .*secret/m);
    });

    it('le NIVEAU se pose et se relit', async () => {
      const d = await fabrique();
      await d.executeCommand('username bob privilege 15 secret Cisco123');
      expect(await conf(d)).toMatch(/^username bob privilege 15 /m);
    });

    it('un niveau HORS de 0-15 est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username bob privilege 16 secret Cisco123'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/privilege 16/);
    });

    it('un niveau qui n est pas un nombre est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username bob privilege zorglub secret Cisco123'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('un mot-cle INCONNU est refuse, pas range', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username bob zorglub Cisco123')).toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('`nopassword` declare un compte sans secret', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username zoe nopassword')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^username zoe nopassword\s*$/m);
    });

    it('`no username` supprime le compte', async () => {
      const d = await fabrique();
      await d.executeCommand('username bob secret Cisco123');
      await d.executeCommand('no username bob');
      expect(await conf(d)).not.toMatch(/^username bob/m);
    });

    it('la commande sans nom est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username')).toMatch(/Incomplete command/);
    });

    it('le niveau par DEFAUT ne parait pas dans la configuration', async () => {
      const d = await fabrique();
      await d.executeCommand('username zoe privilege 1 secret Cisco123');
      const texte = await conf(d);
      expect(texte).toMatch(/^username zoe secret /m);
      expect(texte).not.toMatch(/username zoe privilege 1/);
    });

    it('`algorithm-type scrypt` est honore et non jete', async () => {
      const d = await fabrique();
      await d.executeCommand('username zoe algorithm-type scrypt secret Cisco123');
      expect(await conf(d)).toMatch(/^username zoe secret 9 /m);
    });

    it('`algorithm-type` INCONNU est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username bob algorithm-type zorglub secret X'))
        .toMatch(REFUS);
    });

    it('un condense DEJA calcule est garde tel quel', async () => {
      const d = await fabrique();
      await d.executeCommand('username zoe secret 5 $1$abcd$efgh');
      expect(await conf(d)).toContain('username zoe secret 5 $1$abcd$efgh');
    });

    it('l aide de la place du NOM annonce un mot', async () => {
      const d = await fabrique();
      expect(d.cliHelp('username ')).toMatch(/WORD/);
    });

    it('l aide apres le nom annonce les reglages', async () => {
      const d = await fabrique();
      const aide = d.cliHelp('username bob ');
      expect(aide).toMatch(/^\s+privilege\b/m);
      expect(aide).toMatch(/^\s+secret\b/m);
      expect(aide).toMatch(/^\s+password\b/m);
    });

    it('l aide de la place du NIVEAU annonce <0-15>', async () => {
      const d = await fabrique();
      expect(d.cliHelp('username bob privilege ')).toContain('<0-15>');
    });
  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'username bob privilege 16 secret X',
    'username bob privilege zorglub secret X',
    'username bob zorglub X',
    'username',
    'username bob algorithm-type zorglub secret X',
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

  it('la ligne de configuration est ECRITE PAREIL', async () => {
    const r = await routeur(); const s = await commutateur();
    await r.executeCommand('username bob privilege 15 secret Cisco123');
    await s.executeCommand('username bob privilege 15 secret Cisco123');
    const ligne = (t: string) =>
      (t.split('\n').find((l) => l.startsWith('username bob')) ?? '');
    expect(ligne(await conf(s))).toBe(ligne(await conf(r)));
  });

  it('la DESCRIPTION de `username` est la meme des deux cotes', async () => {
    const r = await routeur(); const s = await commutateur();
    const decrit = (aide: string): string =>
      (aide.split('\n').find((l) => /^\s+username\s/.test(l)) ?? '')
        .trim().replace(/^username\s+/, '');
    const cote = decrit(r.cliHelp(''));
    expect(cote.length).toBeGreaterThan(0);
    expect(decrit(s.cliHelp(''))).toBe(cote);
  });
});

/*
 * SUITE — les formes TRONQUEES, ecrites A L'AVEUGLE depuis la
 * documentation IOS de `username` avant toute lecture du code.
 *
 * Ce que la reference dit, et que les 18 premiers cas ne touchaient
 * pas :
 *   `username <nom> secret { 0 <mot> | 4 | 5 | 8 | 9 <condense> }`,
 *   `username <nom> password { 0 | 7 } <chaine>`,
 *   `username <nom> view <vue>`, `access-class <1-199>`,
 *   `user-maxlinks <0-255>`.
 * Une valeur ABSENTE n'est pas un LINE : la commande est INCOMPLETE.
 *
 * Discriminee contre l'etat d'avant : 16 des 91 cas tombent. Les 75
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - les 18 cas d'origine passaient deja, et le doivent : ils portent
 *     sur les formes COMPLETES, que le glouton honorait ;
 *   - `no username` et les cinq cas de REFUS passaient parce que le
 *     gestionnaire controlait deja `privilege`, `access-class` et
 *     `user-maxlinks` quand la valeur etait PRESENTE — c'est son
 *     ABSENCE qu'il n'exigeait nulle part ;
 *   - `password 7`, `secret 8|9`, le chiffre inconnu et la description
 *     de plusieurs mots sont des cas de NON-REGRESSION : ils gardent
 *     que le sac d'options n'a rien perdu de ce que la boucle faisait ;
 *   - `view INEXISTANTE` passait, la verification de la vue existant
 *     deja et etant simplement DEPLACEE dans le gestionnaire declare.
 *
 * DEUX PREMISSES DE CETTE SUITE ETAIENT FAUSSES et la reference les a
 * corrigees plutot que le code : j'avais exige que `username bob secret
 * 99 abcd` et `username bob password 9 abcd` soient REFUSES, le chiffre
 * n'etant pas un type de condense connu. Mais la forme NUE `secret
 * <LINE>` existe aussi, et `99 abcd` est un LINE parfaitement valide —
 * une vraie machine en fait donc le mot de passe. Les deux cas sont
 * retires : les garder aurait fait refuser une saisie qu'IOS accepte.
 */

const MANQUANTS: readonly string[] = [
  'username bob secret',
  'username bob password',
  'username bob privilege',
  'username bob view',
  'username bob algorithm-type',
  'username bob algorithm-type scrypt secret',
  'username bob access-class',
  'username bob user-maxlinks',
  'no username',
];

const REFUSES: readonly string[] = [
  'username bob access-class zorglub',
  'username bob access-class 0',
  'username bob user-maxlinks 256',
  'username bob privilege 15 zorglub Cisco123',
  'username bob nopassword zorglub',
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`username\` — formes tronquees et refusees sur un ${nom}`, () => {
    for (const saisie of MANQUANTS) {
      it(`\`${saisie}\` est INCOMPLETE`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(saisie)).toMatch(/Incomplete command/);
      });
    }

    for (const saisie of REFUSES) {
      it(`\`${saisie}\` est refuse, pas range`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(saisie)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });
    }

    it('`view` exige une vue qui EXISTE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username zoe view INEXISTANTE secret X'))
        .toMatch(/Invalid input|not present|%/);
      expect(await conf(d)).not.toMatch(/view INEXISTANTE/);
    });

    it('`privilege 15` seul, sans secret, se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username zoe privilege 15')).not.toMatch(REFUS);
      expect(await conf(d)).toMatch(/^username zoe privilege 15\s*$/m);
    });

    it('`password 7` garde le condense tel quel', async () => {
      const d = await fabrique();
      await d.executeCommand('username zoe password 7 070C285F4D06');
      expect(await conf(d)).toContain('username zoe password 7 070C285F4D06');
    });

    it('`secret 8` et `secret 9` sont acceptes', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username zoe secret 8 $8$abcd$efgh'))
        .not.toMatch(REFUS);
      expect(await d.executeCommand('username ava secret 9 $9$abcd$efgh'))
        .not.toMatch(REFUS);
    });

    it('une DESCRIPTION de plusieurs mots se relit entiere', async () => {
      const d = await fabrique();
      await d.executeCommand('username zoe description Chef du reseau');
      expect(await conf(d)).toContain('description Chef du reseau');
    });

    it('un CHIFFRE inconnu reste le mot de passe, comme sur IOS', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('username zoe secret 99 abcd')).not.toMatch(REFUS);
    });
  });
}

describe('les formes tronquees repondent la MEME chose des deux cotes', () => {
  for (const saisie of [...MANQUANTS, ...REFUSES]) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
      const cote = nettoie(await r.executeCommand(saisie));
      expect(cote.length).toBeGreaterThan(0);
      expect(nettoie(await s.executeCommand(saisie))).toBe(cote);
    });
  }
});
