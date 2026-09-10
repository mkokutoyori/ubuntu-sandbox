/*
 * Sonde ECRITE A L'AVEUGLE sur les SOUS-MODES d'ACL nommee, avant toute
 * lecture des declarations du commutateur.
 *
 * LA REFERENCE N'A PAS PU ETRE ATTEINTE : cisco.com est bloque par le
 * mandataire de sortie de ce reseau. La sonde n'exige donc aucune
 * formulation. Elle exige DEUX choses qui se mesurent sur les machines
 * seules :
 *
 *   1. une liste STANDARD est une liste standard. Elle ne connait ni
 *      protocole ni destination — c'est ce qui la distingue d'une
 *      etendue — et elle n'evalue pas de liste REFLEXIVE. Ce que la
 *      machine annonce a cette place doit donc s'y executer, et ce
 *      qu'elle refuse ne doit pas entrer dans la configuration.
 *   2. un routeur et un commutateur Cisco sont la MEME CLI. La meme
 *      frappe, au meme endroit, doit rendre le meme mot.
 *
 * POURQUOI CELA COUTE CHER : une entree acceptee dans une liste ou elle
 * n'a pas de sens n'est pas une faute de frappe, c'est une regle de
 * filtrage que l'operateur croit avoir posee. Elle est RENDUE par
 * `show running-config`, donc rejouee a l'import d'une topologie, et
 * elle ne filtre rien.
 *
 * Les deux machines portent le MEME nom d'hote : le caret d'IOS se
 * compte depuis le debut de la ligne, invite comprise. C'est le nom qui
 * est neutralise, pas la mesure.
 *
 * Discriminee contre l'etat d'avant : 13 des 63 cas tombent, TOUS du
 * cote du commutateur ou entre les deux plateformes. Les 50 autres sont
 * nommes ici plutot que laisses a decouvrir.
 *   - la moitie ROUTEUR passe en entier, et le doit : il avait deja ses
 *     deux arbres, un par sorte de liste. C'est lui le TEMOIN de ce lot
 *     — un correctif qui aurait aligne les deux plateformes en abimant
 *     le routeur serait un echange, pas une correction. C'est aussi lui
 *     qui montre que les phrases attendues ne sont pas inventees : elles
 *     existent deja d'un cote ;
 *   - la liste ETENDUE du commutateur passe presque entierement : son
 *     arbre unique etait celui d'une etendue, et c'est la STANDARD qui
 *     recevait le vocabulaire d'une autre. Ces cas gardent que la
 *     separation ne lui a rien pris — l'aide y descend toujours jusqu'au
 *     port, et `evaluate` y range toujours son nom ;
 *   - les saisies acceptees des deux cotes passaient : le moteur d'ACE
 *     est le meme `parseCiscoAce` et les deux plateformes tiennent leurs
 *     listes dans le meme `ACLEngine`. Ce qui divergeait n'etait pas le
 *     moteur, mais ce que chaque shell declarait devant lui.
 *
 * CORRIGE DEPUIS : ce fichier EPINGLAIT un defaut. Il exigeait qu'une
 * liste ETENDUE annonce, derriere `permit`, les protocoles ET `any` /
 * `host` — les formes de source d'une liste STANDARD, que la meme
 * machine refuse a cette place (`permit any any` n'a pas de protocole).
 * L'exigence est devenue celle qui se verifie : les protocoles sont
 * annonces, les deux formes de source ne le sont pas. La phrase attendue
 * pour `permit` est passee de « Specify packets to permit » — que rien
 * ne portait ailleurs dans le depot — a « Specify packets to forward »,
 * celle qu'IOS ecrit et que `access-list`, la liste MAC et la route-map
 * ecrivaient deja ici.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  getPrompt: () => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

const HOTE = 'X';

async function entrer(d: Cli, liste: string): Promise<Cli> {
  d.powerOn();
  for (const c of ['enable', 'configure terminal', liste]) await d.executeCommand(c);
  return d;
}

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(HOTE, 0, 0) as unknown as Cli],
  ['commutateur', () => new CiscoSwitch('switch-cisco', HOTE, 8, 0, 0) as unknown as Cli],
];

const LISTES: ReadonlyArray<readonly ['standard' | 'etendue', string]> = [
  ['standard', 'ip access-list standard SL'],
  ['etendue', 'ip access-list extended EL'],
];

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

/** Les protocoles n'existent que dans une liste ETENDUE. */
const PROTOCOLES = ['icmp', 'ip', 'tcp', 'udp'] as const;
const SOURCES = ['A.B.C.D', 'any', 'host'] as const;

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`une liste STANDARD est standard, sur un ${plateforme}`, () => {
    const std = () => entrer(fabrique(), 'ip access-list standard SL');

    it('`permit ?` n annonce AUCUN protocole', async () => {
      const d = await std();
      const rendus = mots(d.cliHelp('permit '));
      for (const proto of PROTOCOLES) {
        expect(rendus, `permit ? offre ${proto}`).not.toContain(proto);
      }
    });

    it('`permit ?` annonce ses trois formes de source', async () => {
      const d = await std();
      expect(mots(d.cliHelp('permit ')).sort()).toEqual([...SOURCES].sort());
    });

    it('`deny ?` annonce la meme chose que `permit ?`', async () => {
      const d = await std();
      expect(mots(d.cliHelp('deny ')).sort()).toEqual(mots(d.cliHelp('permit ')).sort());
    });

    it('n annonce pas `evaluate`', async () => {
      const d = await std();
      expect(mots(d.cliHelp(''))).not.toContain('evaluate');
    });

    it('REFUSE `evaluate`, et ne le range pas', async () => {
      const d = await std();
      expect(await d.executeCommand('evaluate REFLEX')).toMatch(/Invalid input/);
      expect(await conf(d)).not.toContain('REFLEX');
    });

    it('REFUSE une entree a protocole', async () => {
      const d = await std();
      expect(await d.executeCommand('permit tcp any any eq 80'))
        .toMatch(/Invalid input/);
      expect(await conf(d)).not.toContain('tcp');
    });

    it('accepte ses propres formes — le TEMOIN', async () => {
      const d = await std();
      for (const ligne of ['permit any', 'deny host 10.0.0.1', 'remark essai']) {
        expect(await d.executeCommand(ligne), ligne).not.toMatch(/Invalid|Incomplete/);
      }
      const texte = await conf(d);
      expect(texte).toContain('permit any');
      expect(texte).toContain('deny host 10.0.0.1');
    });

    it('l invite dit STANDARD', async () => {
      const d = await std();
      expect(d.getPrompt()).toMatch(/\(config-std-nacl\)#$/);
    });
  });

  describe(`une liste ETENDUE est etendue, sur un ${plateforme}`, () => {
    const ext = () => entrer(fabrique(), 'ip access-list extended EL');

    it('`permit ?` annonce les protocoles, et PAS les formes de source', async () => {
      const d = await ext();
      const rendus = mots(d.cliHelp('permit '));
      expect(rendus).toEqual(expect.arrayContaining([...PROTOCOLES]));
      for (const forme of ['any', 'host']) {
        expect(rendus, `permit ? offre ${forme}, qui n a pas de protocole`)
          .not.toContain(forme);
      }
    });

    it('annonce `evaluate`', async () => {
      const d = await ext();
      expect(mots(d.cliHelp(''))).toContain('evaluate');
    });

    it('`evaluate` prend un nom et le range', async () => {
      const d = await ext();
      expect(await d.executeCommand('evaluate REFLEX')).not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('REFLEX');
    });

    it('accepte une entree a protocole et a port', async () => {
      const d = await ext();
      expect(await d.executeCommand('permit tcp any any eq 80'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('permit tcp any any eq');
    });

    it('l aide descend jusqu au PORT', async () => {
      const d = await ext();
      expect(mots(d.cliHelp('permit tcp any any eq ')))
        .toEqual(expect.arrayContaining(['<0-65535>', 'www']));
    });

    it('l invite dit ETENDUE', async () => {
      const d = await ext();
      expect(d.getPrompt()).toMatch(/\(config-ext-nacl\)#$/);
    });
  });

  describe(`les mots du sous-mode portent les phrases d IOS, sur un ${plateforme}`, () => {
    for (const [genre, liste] of LISTES) {
      it(`dans une liste ${genre}`, async () => {
        const d = await entrer(fabrique(), liste);
        const aide = d.cliHelp('');
        expect(aide).toContain('Specify packets to forward');
        expect(aide).toContain('Specify packets to reject');
        expect(aide).not.toMatch(/ACL (permit|deny|no|evaluate)\b/);
      });
    }
  });
}

describe('les deux plateformes repondent la MEME chose dans un sous-mode d ACL', () => {
  const AIDES: readonly string[] = [
    '', 'permit ', 'deny ', 'remark ', 'no ',
    'permit host ', 'permit any ',
  ];
  const AIDES_ETENDUES: readonly string[] = [
    'permit tcp ', 'permit tcp any ', 'permit tcp any any ',
    'permit tcp any any eq ', 'evaluate ',
  ];
  const SAISIES: readonly string[] = [
    'permit', 'deny', 'remark', 'evaluate', 'permit zorglub',
  ];

  for (const [genre, liste] of LISTES) {
    const aides = genre === 'etendue' ? [...AIDES, ...AIDES_ETENDUES] : AIDES;

    for (const aide of aides) {
      it(`liste ${genre} — \`${aide}?\``, async () => {
        const r = await entrer(FABRIQUES[0][1](), liste);
        const s = await entrer(FABRIQUES[1][1](), liste);
        expect(s.cliHelp(aide)).toBe(r.cliHelp(aide));
      });
    }

    for (const saisie of SAISIES) {
      it(`liste ${genre} — \`${saisie}\``, async () => {
        const r = await entrer(FABRIQUES[0][1](), liste);
        const s = await entrer(FABRIQUES[1][1](), liste);
        const cote = await r.executeCommand(saisie);
        expect(cote.trim().length).toBeGreaterThan(0);
        expect(await s.executeCommand(saisie)).toBe(cote);
      });
    }

    it(`liste ${genre} — la meme invite`, async () => {
      const r = await entrer(FABRIQUES[0][1](), liste);
      const s = await entrer(FABRIQUES[1][1](), liste);
      expect(s.getPrompt()).toBe(r.getPrompt());
    });
  }
});
