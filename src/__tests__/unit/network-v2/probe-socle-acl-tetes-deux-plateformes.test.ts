/*
 * Sonde ECRITE A L'AVEUGLE sur les TETES de la famille ACL, avant toute
 * lecture des declarations du commutateur.
 *
 * LA REFERENCE N'A PAS PU ETRE ATTEINTE : cisco.com est bloque par le
 * mandataire de sortie de ce reseau. Rien n'est donc invente ici, et la
 * sonde n'exige aucune formulation particuliere. Ce qu'elle exige est
 * qu'il n'y en ait qu'UNE : `access-list` et `ip access-list` sont la
 * MEME commande sur un routeur et sur un commutateur Cisco, donc la
 * meme frappe doit rendre le meme mot, le meme refus et le meme caret.
 * Cela se mesure sur les deux machines seules, sans rien citer.
 *
 * `probe-famille-ip-access-list` couvre deja cette famille SUR UN
 * ROUTEUR, et la couvre bien ; elle ne l'a jamais tapee sur un
 * commutateur. C'est ce trou-la qu'on mesure, pas la famille.
 *
 * POURQUOI CELA COUTE CHER : une ACL est une decision de securite. Deux
 * plateformes qui repondent deux choses a la meme ligne, c'est un
 * laboratoire ou l'eleve apprend une regle fausse sur l'une des deux —
 * et une configuration exportee d'une machine que l'autre relit
 * autrement.
 *
 * Les deux machines portent le MEME nom d'hote : le caret d'IOS se
 * compte depuis le debut de la ligne, invite comprise, donc deux noms
 * de longueurs differentes rendraient deux colonnes pour une meme
 * faute. C'est le nom qui est neutralise, pas la mesure.
 *
 * Discriminee contre l'etat d'avant : 17 des 67 cas tombent. Les 50
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - `access-list ?` et `no access-list ?` s'accordaient deja des deux
 *     cotes : les quatre plages etaient decrites par `ciscoArgumentHelp`,
 *     qui est commun aux deux plateformes. C'est la preuve que le
 *     desaccord ne vient pas du hasard mais des declarations PROPRES a
 *     chaque shell — celles-la seules divergeaient ;
 *   - douze des seize saisies croisees passaient : les deux moteurs
 *     d'ACE sont le meme `parseCiscoAce`, donc tout ce qui va jusqu'a
 *     lui rendait deja le meme verdict. Ce qui divergeait est ce qui
 *     n'y arrivait pas — les TETES ;
 *   - vingt et un des vingt-deux cas du ROUTEUR passaient, et le
 *     doivent : sa famille etait deja declaree place par place. Ils
 *     sont les TEMOINS de ce lot — un correctif qui aurait aligne les
 *     deux plateformes en abimant le routeur serait un echange, pas une
 *     correction ;
 *   - les poses et les relectures passaient des deux cotes : le defaut
 *     n'etait pas que la commande echoue, mais qu'elle se decrive et se
 *     refuse autrement selon la machine.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

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

/** Le meme nom des deux cotes : le caret se compte depuis l'invite. */
const HOTE = 'X';

async function amorcer(d: Cli): Promise<void> {
  d.powerOn();
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
}

async function routeur(): Promise<Cli> {
  const r = new CiscoRouter(HOTE, 0, 0) as unknown as Cli;
  await amorcer(r);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new CiscoSwitch('switch-cisco', HOTE, 8, 0, 0) as unknown as Cli;
  await amorcer(s);
  return s;
}

const PLATEFORMES: ReadonlyArray<readonly [string, () => Promise<Cli>]> = [
  ['routeur', routeur],
  ['commutateur', commutateur],
];

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

const AIDES: readonly string[] = [
  'access-list ',
  'no access-list ',
  'ip access-list ',
  'ip access-list standard ',
  'ip access-list extended ',
  'ip access-list resequence ',
  'no ip access-list ',
];

const SAISIES: readonly string[] = [
  'access-list',
  'access-list 10',
  'access-list 10 zorglub',
  'access-list 2700 permit any',
  'access-list zorglub permit any',
  'no access-list',
  'no access-list zorglub',
  'ip access-list',
  'ip access-list standard',
  'ip access-list extended',
  'ip access-list zorglub NOM',
  'ip access-list resequence',
  'ip access-list resequence NOM',
  'no ip access-list',
  'no ip access-list standard',
  'no ip access-list zorglub NOM',
];

describe('les deux plateformes decrivent la famille ACL avec les MEMES mots', () => {
  for (const aide of AIDES) {
    it(`\`${aide}?\``, async () => {
      const r = await routeur(); const s = await commutateur();
      expect(s.cliHelp(aide)).toBe(r.cliHelp(aide));
    });
  }
});

describe('les deux plateformes repondent la MEME chose', () => {
  for (const saisie of SAISIES) {
    it(`\`${saisie}\``, async () => {
      const r = await routeur(); const s = await commutateur();
      const cote = await r.executeCommand(saisie);
      expect(cote.trim().length).toBeGreaterThan(0);
      expect(await s.executeCommand(saisie)).toBe(cote);
    });
  }
});

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`\`ip access-list\` sur un ${nom}`, () => {
    it('annonce ses trois sortes et rien d autre', async () => {
      const d = await fabrique();
      expect(mots(d.cliHelp('ip access-list ')).sort())
        .toEqual(['extended', 'resequence', 'standard']);
    });

    it('seul, il est INCOMPLET et ne promet pas de `<cr>`', async () => {
      const d = await fabrique();
      expect(annonceCr(d.cliHelp('ip access-list '))).toBe(false);
      expect(await d.executeCommand('ip access-list')).toMatch(/Incomplete command/);
    });

    for (const sorte of ['standard', 'extended', 'resequence']) {
      it(`\`ip access-list ${sorte}\` sans nom est INCOMPLET`, async () => {
        const d = await fabrique();
        expect(annonceCr(d.cliHelp(`ip access-list ${sorte} `))).toBe(false);
        expect(await d.executeCommand(`ip access-list ${sorte}`))
          .toMatch(/Incomplete command/);
      });
    }

    it('une sorte inventee est refusee', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-list zorglub NOM'))
        .toMatch(/Invalid input/);
    });

    it('la forme STANDARD se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-list standard SL'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('ip access-list standard SL');
    });

    it('la forme ETENDUE se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-list extended EL'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('ip access-list extended EL');
    });

    it('`no ip access-list` retire la liste', async () => {
      const d = await fabrique();
      await d.executeCommand('ip access-list standard SL');
      await d.executeCommand('exit');
      expect(await d.executeCommand('no ip access-list standard SL'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).not.toContain('ip access-list standard SL');
    });
  });

  describe(`\`ip access-list resequence\` sur un ${nom}`, () => {
    it('annonce le DEBUT apres le nom', async () => {
      const d = await fabrique();
      expect(mots(d.cliHelp('ip access-list resequence NOM ')).join(' '))
        .toMatch(/<\d+-\d+>/);
    });

    it('sans le debut, elle est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-list resequence NOM'))
        .toMatch(/Incomplete command/);
    });

    it('sans le pas, elle est INCOMPLETE', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('ip access-list resequence NOM 100'))
        .toMatch(/Incomplete command/);
    });

    it('elle renumerote ce qui existe', async () => {
      const d = await fabrique();
      for (const c of ['ip access-list standard SL', 'permit any', 'exit']) {
        await d.executeCommand(c);
      }
      expect(await d.executeCommand('ip access-list resequence SL 100 10'))
        .not.toMatch(/Invalid|Incomplete/);
    });
  });

  describe(`\`access-list <numero>\` sur un ${nom}`, () => {
    it('annonce les quatre plages', async () => {
      const d = await fabrique();
      expect(mots(d.cliHelp('access-list ')))
        .toEqual(expect.arrayContaining(
          ['<1-99>', '<100-199>', '<1300-1999>', '<2000-2699>']));
    });

    it('annonce ses trois actions apres le numero', async () => {
      const d = await fabrique();
      expect(mots(d.cliHelp('access-list 10 ')).sort())
        .toEqual(['deny', 'permit', 'remark']);
    });

    it('seul, il est INCOMPLET', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('access-list')).toMatch(/Incomplete command/);
    });

    it('sans action, il est INCOMPLET', async () => {
      const d = await fabrique();
      expect(annonceCr(d.cliHelp('access-list 10 '))).toBe(false);
      expect(await d.executeCommand('access-list 10')).toMatch(/Incomplete command/);
    });

    it('une action inventee est refusee au caret', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('access-list 10 zorglub'))
        .toMatch(/Invalid input detected at '\^' marker/);
    });

    it('un numero hors plage est refuse', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('access-list 2700 permit any'))
        .toMatch(/Invalid input/);
    });

    it('une entree se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('access-list 10 permit any'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('access-list 10 permit');
    });

    it('`remark` se pose et se relit', async () => {
      const d = await fabrique();
      expect(await d.executeCommand('access-list 10 remark essai de commentaire'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('essai de commentaire');
    });

    it('`no access-list` retire la liste', async () => {
      const d = await fabrique();
      await d.executeCommand('access-list 10 permit any');
      expect(await d.executeCommand('no access-list 10'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).not.toContain('access-list 10 permit');
    });
  });
}
