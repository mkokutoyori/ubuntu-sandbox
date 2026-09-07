/*
 * Sonde ECRITE A L'AVEUGLE depuis la documentation IOS des listes de
 * methodes AAA, avant toute lecture du code.
 *
 * Ce que la reference dit :
 *   `aaa authentication login {default | <liste>} <methode> [<methode>…]`
 *     methodes : `enable`, `group <nom>`, `krb5`, `krb5-telnet`, `line`,
 *     `local`, `local-case`, `none`.
 *   `aaa authorization {exec | commands <0-15> | network | …}
 *      {default | <liste>} <methode> [<methode>…]`
 *     methodes : `group <nom>`, `if-authenticated`, `local`, `none`.
 *   `aaa accounting {exec | commands <0-15> | network | …}
 *      {default | <liste>} {start-stop | stop-only | none} [group <nom>]`
 *
 * Pourquoi une methode inventee se paie en ACCES : une liste de
 * methodes est essayee dans l'ordre, et une entree que rien ne sait
 * appliquer est une entree qui n'authentifie personne. L'operateur croit
 * avoir pose un repli — c'est precisement ce que ces listes servent a
 * decrire — et n'a rien pose. La configuration rendue est REJOUEE a
 * l'import d'une topologie, donc la ligne fautive revient telle quelle.
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

const AMORCE = ['enable', 'configure terminal', 'aaa new-model'];

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
  describe(`les methodes AAA sur un ${nom}`, () => {
    it('une liste d authentification VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      const ligne = 'aaa authentication login default local none';
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });

    it('une METHODE d authentification inventee est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authentication login default zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('une methode inventee APRES une valide est refusee aussi', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authentication login default local zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('une liste d autorisation VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      const ligne = 'aaa authorization exec default local';
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });

    it('une METHODE d autorisation inventee est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authorization exec default zorglub'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('`group` sans nom de groupe est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa authentication login default group'))
        .toMatch(/Incomplete command/);
    });

    it('le NIVEAU de `aaa accounting commands` est un nombre', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'aaa accounting commands zorglub start-stop group tacacs+'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/zorglub/);
    });

    it('et il est borne a 0-15', async () => {
      const d = await fabrique();
      expect(await d.executeCommand(
        'aaa accounting commands 16 default start-stop group tacacs+'))
        .toMatch(REFUS);
      expect(await conf(d)).not.toMatch(/commands 16/);
    });

    it('une liste de comptabilite VALIDE se pose et se relit', async () => {
      const d = await fabrique();
      const ligne = 'aaa accounting commands 15 default start-stop group tacacs+';
      expect(await d.executeCommand(ligne)).not.toMatch(REFUS);
      expect(await conf(d)).toContain(ligne);
    });

  });
}

describe('les deux plateformes repondent la MEME chose', () => {
  const SAISIES = [
    'aaa authentication login default zorglub',
    'aaa authentication login default local zorglub',
    'aaa authorization exec default zorglub',
    'aaa accounting commands zorglub start-stop group tacacs+',
    'aaa accounting commands 16 default start-stop group tacacs+',
    'aaa authentication login default group',
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

/*
 * SUITE — les TETES de `aaa`, ecrites A L'AVEUGLE depuis la
 * documentation IOS avant toute lecture du code.
 *
 * La sonde d'origine mesurait les LISTES DE METHODES. Ce qui restait a
 * mesurer est ce qui les porte : les six autres formes de la tete.
 *
 * Ce que la reference dit :
 *   `aaa group server { radius | tacacs+ } <nom>` — DEUX sortes, pas
 *   une de plus : le groupe declare le protocole que ses membres
 *   parlent, donc s'en tromper envoie les demandes au mauvais port avec
 *   la mauvaise mise en forme ;
 *   `aaa new-model` — aucun mot apres ;
 *   `aaa session-id { common | unique }` ;
 *   `aaa local authentication attempts max-fail <nombre>`.
 *
 * NON MESURE ET DIT PLUTOT QUE DEVINE : la PLAGE de `max-fail` n'est
 * attestee par aucune source atteignable depuis ce reseau — la
 * documentation Cisco decrit la commande sans borner la valeur. Aucun
 * cas ne l'exige donc, et la declaration n'en pose pas : annoncer un
 * `<min-max>` invente ferait refuser une saisie qu'une vraie machine
 * accepte.
 *
 * Discriminee contre l'etat d'avant : 40 des 89 cas tombent. Les 49
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - les 24 cas d'origine — 18 par plateforme, 6 croises — passaient
 *     deja, et le doivent : ils portent sur les LISTES DE METHODES, que
 *     le gestionnaire glouton analysait mot a mot ; c'est ce qui les
 *     PORTE qu'il avalait ;
 *   - `aaa group server radius GR` et `aaa group server tacacs+ GT`
 *     passaient : le defaut n'etait pas que la forme complete echoue,
 *     mais que ses voisines tronquees reussissent ;
 *   - `le groupe declare la SORTE qu on a nommee` passait pour
 *     `tacacs+`, seul mot que le ternaire `args[2] === 'tacacs+'`
 *     reconnaissait ; c'est `zorglub` qui devenait un groupe RADIUS, et
 *     ce cas-la tombe ;
 *   - `aaa new-model` seul est le TEMOIN : il passe des deux cotes, et
 *     doit, sinon le laboratoire ne mesure rien. `aaa session-id
 *     unique` est son pendant pour la forme complete ;
 *   - `aaa local authentication attempts max-fail zorglub` passait, par
 *     plateforme et croise : cette forme-la, seule, controlait deja son
 *     nombre. C'est son ABSENCE qu'elle n'exigeait nulle part ;
 *   - dans la suite `<cr>`, les dix `no <saisie>` passent : la negation
 *     se passait deja de la valeur — c'est l'aide qui mentait, pas le
 *     `no`. Ils sont la pour garder que le correctif n'a pas achete
 *     l'honnetete de `?` au prix de la negation. Et `aaa session-id ?`
 *     passait parce que le trie n'annoncait pas `<cr>` : c'est en le
 *     migrant qu'on l'aurait perdu.
 */

const TETES_INCOMPLETES: readonly string[] = [
  'aaa group',
  'aaa group server',
  'aaa group server radius',
  'aaa group server tacacs+',
  'aaa local authentication attempts max-fail',
  'aaa local',
];

const TETES_REFUSEES: readonly string[] = [
  'aaa group server zorglub G1',
  'aaa group serveur radius G1',
  'aaa local zorglub',
  'aaa local authentication zorglub',
  'aaa local authentication attempts max-fail zorglub',
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`les TETES de \`aaa\` sur un ${nom}`, () => {
    for (const saisie of TETES_INCOMPLETES) {
      it(`\`${saisie}\` est INCOMPLETE`, async () => {
        const d = await fabrique();
        await d.executeCommand('aaa new-model');
        expect(await d.executeCommand(saisie)).toMatch(/Incomplete command/);
      });
    }

    for (const saisie of TETES_REFUSEES) {
      it(`\`${saisie}\` est refuse, pas avale`, async () => {
        const d = await fabrique();
        await d.executeCommand('aaa new-model');
        expect(await d.executeCommand(saisie)).toMatch(/Invalid input/);
        expect(await conf(d)).not.toMatch(/zorglub|serveur/);
      });
    }

    it('un groupe RADIUS se declare et se relit', async () => {
      const d = await fabrique();
      await d.executeCommand('aaa new-model');
      expect(await d.executeCommand('aaa group server radius GR')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('aaa group server radius GR');
    });

    it('un groupe TACACS+ se declare et se relit', async () => {
      const d = await fabrique();
      await d.executeCommand('aaa new-model');
      expect(await d.executeCommand('aaa group server tacacs+ GT')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('aaa group server tacacs+ GT');
    });

    it('le groupe declare la SORTE qu on a nommee', async () => {
      const d = await fabrique();
      await jouer(d, ['aaa new-model', 'aaa group server tacacs+ GT']);
      const texte = await conf(d);
      expect(texte).toContain('aaa group server tacacs+ GT');
      expect(texte).not.toContain('aaa group server radius GT');
    });

    it('`aaa new-model` seul reste accepte — le TEMOIN', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa new-model')).not.toMatch(REFUS);
      expect(await conf(d)).toContain('aaa new-model');
    });

    it('`aaa session-id unique` se pose', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('aaa session-id unique')).not.toMatch(REFUS);
    });

    it('`no aaa group server` retire le groupe', async () => {
      const d = await fabrique();
      await jouer(d, ['aaa new-model', 'aaa group server radius GR', 'exit']);
      expect(await d.executeCommand('no aaa group server radius GR'))
        .not.toMatch(REFUS);
      expect(await conf(d)).not.toContain('aaa group server radius GR');
    });
  });
}

describe('les TETES repondent la MEME chose des deux cotes', () => {
  for (const saisie of [...TETES_INCOMPLETES, ...TETES_REFUSEES]) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      await r.executeCommand('aaa new-model');
      await s.executeCommand('aaa new-model');
      const nettoie = (t: string) => t.replace(/\^/g, '').replace(/\s+/g, ' ').trim();
      const cote = nettoie(await r.executeCommand(saisie));
      expect(cote.length).toBeGreaterThan(0);
      expect(nettoie(await s.executeCommand(saisie))).toBe(cote);
    });
  }
});

/*
 * SUITE — `?` ne promet pas un `<cr>` que la machine refuse.
 *
 * Une place exigee au POSITIF et omise au NEGATIF n'etait pas
 * exprimable : `aaa session-id common` veut sa valeur, `no aaa
 * session-id` s'en passe. La declarer facultative faisait annoncer
 * `<cr>` par `?` pour une frappe que la meme machine refuse — le
 * mensonge que les trois garde-fous de l'aide existent pour empecher —
 * et l'exiger rendait la negation incomplete. `undoOmitsArguments`
 * porte la nuance ; ces cas la mesurent des DEUX cotes, parce qu'un
 * correctif qui rendrait l'aide juste en cassant le `no` serait un
 * echange, pas une correction.
 */

const PLACES_OMISES_AU_NEGATIF: readonly string[] = [
  'aaa session-id',
  'aaa local authentication attempts max-fail',
  'radius-server timeout',
  'radius-server key',
  'tacacs-server port',
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`?\` ne promet pas de \`<cr>\` menteur sur un ${nom}`, () => {
    for (const saisie of PLACES_OMISES_AU_NEGATIF) {
      it(`\`${saisie} ?\` n'annonce pas <cr>, et la frappe est INCOMPLETE`, async () => {
        const d = await fabrique();
        expect(d.cliHelp(`${saisie} `)).not.toContain('<cr>');
        expect(await d.executeCommand(saisie)).toMatch(/Incomplete command/);
      });

      it(`\`no ${saisie}\` se passe de la valeur`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`no ${saisie}`)).not.toMatch(REFUS);
      });
    }
  });
}
