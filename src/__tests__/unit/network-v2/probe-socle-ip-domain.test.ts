/*
 * Sonde ECRITE A L'AVEUGLE sur la configuration du RESOLVEUR DNS :
 * `ip domain-*`, `ip domain *`, `ip name-server`, `ip host`, `ip dns *`.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Rien de ce que la sonde exige n'en depend :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. chaque mot que `?` annonce s'EXECUTE ;
 *   3. une plage ANNONCEE est une plage APPLIQUEE ;
 *   4. un routeur et un Catalyst sont la MEME CLI ;
 *   5. ce qui est pose se relit dans `show running-config`.
 *
 * Le point qui vaut cette sonde est le SIXIEME, et c'est la regle de
 * coherence du depot : IOS ecrit le meme reglage de DEUX facons —
 * `ip domain-name X` (heritee) et `ip domain name X` (moderne), de meme
 * pour `domain-lookup`/`domain lookup` et `domain-list`/`domain list`.
 * Ce sont deux ORTHOGRAPHES d'UN fait, jamais deux reglages. Une machine
 * qui les range dans deux champs repond deux choses differentes a la
 * meme question, et `show running-config` en rend alors DEUX lignes la
 * ou un IOS n'en rend qu'une — ce qui casse aussi la relecture d'une
 * configuration importee.
 *
 * Ce que la sonde N'EXIGE PAS, faute de pouvoir le verifier ici : les
 * valeurs par defaut d'IOS (`ip domain retry 2`, `ip domain timeout 3`)
 * et les bornes exactes des deux compteurs. Elle exige seulement que la
 * plage annoncee et la plage appliquee soient la MEME — quelle qu'elle
 * soit.
 *
 * Discriminee contre l'etat d'avant : 4 des 71 cas tombent, et ce sont
 * les quatre de la plage. Le defaut est le MIROIR de celui que ce depot
 * traque d'habitude : la borne etait APPLIQUEE — `borne(args[0], 0, 100)`
 * au fond du gestionnaire — et jamais ANNONCEE, la place etant declaree
 * `REST`. L'operateur lisait `LINE`, tapait `ip domain retry 500`, et ne
 * decouvrait la limite qu'au caret.
 *
 * Les 67 qui passent des deux cotes sont nommes, et ils sont ici la
 * raison d'ecrire la sonde plutot que le correctif seul :
 *
 *   - les dix frappes INCOMPLETES et les onze COMPLETES tenaient deja
 *     leur promesse de `<cr>`, sur les deux plateformes. La famille est
 *     passee au socle par l'adaptateur de trie, qui deduit l'arite des
 *     places declarees — c'est exactement ce que la migration achete, et
 *     c'est la NON-REGRESSION qu'il fallait epingler avant de toucher
 *     aux deux places restantes ;
 *   - les cinq cas de « les deux orthographes sont UN reglage »
 *     passaient deja : `ip domain-name` et `ip domain name` ecrivent
 *     dans le meme champ de `CiscoDnsConfig`, et `show running-config`
 *     n'en rend qu'une ligne. C'est le TEMOIN qui prouve que le
 *     laboratoire mesure quelque chose — une sonde faite de refus seuls
 *     ne prouverait rien — et c'est aussi le point que la regle de
 *     coherence du depot exige de ne jamais perdre ;
 *   - le round-trip par `show running-config` et les neuf comparaisons
 *     entre plateformes passaient deja, pour la meme raison : UNE
 *     declaration, lue par les deux shells.
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
const PLAGE = /^<(\d+)-(\d+)>$/;

const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function enConfig(fabrique: () => Cli, ...entree: string[]): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', ...entree]) await d.executeCommand(c);
  return d;
}

async function config(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

/** Les frappes qui EXIGENT une suite, et ne doivent donc pas promettre `<cr>`. */
const INCOMPLETES: readonly string[] = [
  'ip domain',
  'ip domain-name',
  'ip domain-list',
  'ip domain name',
  'ip domain list',
  'ip domain retry',
  'ip domain timeout',
  'ip name-server',
  'ip host',
  'ip dns',
];

/** Les frappes qui se suffisent. */
const COMPLETES: readonly string[] = [
  'ip domain-lookup',
  'ip domain lookup',
  'ip domain round-robin',
  'ip domain-name exemple.net',
  'ip domain name exemple.net',
  'ip domain-list exemple.net',
  'ip domain retry 3',
  'ip domain timeout 5',
  'ip name-server 10.0.0.53',
  'ip host serveur 10.0.0.9',
  'ip dns server',
];

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`le resolveur DNS, sur un ${plateforme}`, () => {
    for (const frappe of INCOMPLETES) {
      it(`\`${frappe} ?\` ne promet pas de \`<cr>\``, async () => {
        const d = await enConfig(fabrique);
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
        expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
      });
    }

    for (const frappe of COMPLETES) {
      it(`\`${frappe}\` s execute et garde son \`<cr>\` — le TEMOIN`, async () => {
        const d = await enConfig(fabrique);
        expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
        expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
      });
    }

    it('chaque mot que `ip domain ?` annonce s EXECUTE', async () => {
      const d = await enConfig(fabrique);
      for (const mot of mots(d.cliHelp('ip domain '))) {
        if (mot === '<cr>' || /^[<A-Z]/.test(mot)) continue;
        expect(await d.executeCommand(`ip domain ${mot}`), `ip domain ${mot}`)
          .not.toMatch(/Invalid input/);
      }
    });

    it('chaque mot que `ip dns ?` annonce s EXECUTE', async () => {
      const d = await enConfig(fabrique);
      for (const mot of mots(d.cliHelp('ip dns '))) {
        if (mot === '<cr>' || /^[<A-Z]/.test(mot)) continue;
        expect(await d.executeCommand(`ip dns ${mot}`), `ip dns ${mot}`)
          .not.toMatch(/Invalid input/);
      }
    });
  });

  describe(`les deux orthographes sont UN reglage, sur un ${plateforme}`, () => {
    it('`ip domain name` ecrase `ip domain-name`, et la configuration en rend UNE ligne', async () => {
      const d = await enConfig(fabrique,
        'ip domain-name premier.net', 'ip domain name second.net');
      const texte = await config(d);
      const lignes = texte.split('\n').filter((l) => /^\s*ip domain[- ]name /.test(l));
      expect(lignes, `rendu : ${lignes.join(' | ')}`).toHaveLength(1);
      expect(lignes[0]).toContain('second.net');
    });

    it('`no ip domain name` defait ce que `ip domain-name` a pose', async () => {
      const d = await enConfig(fabrique, 'ip domain-name premier.net');
      await d.executeCommand('no ip domain name');
      expect(await config(d)).not.toMatch(/^\s*ip domain[- ]name /m);
    });

    it('`no ip domain-name` defait ce que `ip domain name` a pose', async () => {
      const d = await enConfig(fabrique, 'ip domain name second.net');
      await d.executeCommand('no ip domain-name');
      expect(await config(d)).not.toMatch(/^\s*ip domain[- ]name /m);
    });

    it('`no ip domain lookup` eteint ce que `ip domain-lookup` allume', async () => {
      const d = await enConfig(fabrique, 'ip domain-lookup');
      await d.executeCommand('no ip domain lookup');
      const texte = await config(d);
      expect(texte).toMatch(/^\s*no ip domain[- ]lookup\s*$/m);
      const lignes = texte.split('\n').filter((l) => /ip domain[- ]lookup/.test(l));
      expect(lignes, `rendu : ${lignes.join(' | ')}`).toHaveLength(1);
    });

    it('`ip domain list` et `ip domain-list` alimentent UNE liste', async () => {
      const d = await enConfig(fabrique,
        'ip domain-list un.net', 'ip domain list deux.net');
      const texte = await config(d);
      expect(texte).toMatch(/ip domain[- ]list un\.net/);
      expect(texte).toMatch(/ip domain[- ]list deux\.net/);
    });
  });

  describe(`une plage annoncee est une plage appliquee, sur un ${plateforme}`, () => {
    it.each(['ip domain retry', 'ip domain timeout'])('`%s`', async (frappe) => {
      const d = await enConfig(fabrique);
      const annonce = mots(d.cliHelp(`${frappe} `)).find((m) => PLAGE.test(m));
      expect(annonce, `${frappe} ? n annonce aucune plage`).toBeDefined();
      const [, bas, haut] = PLAGE.exec(annonce as string) as RegExpExecArray;
      expect(await d.executeCommand(`${frappe} ${bas}`), `${frappe} ${bas}`)
        .not.toMatch(/Invalid|Incomplete/);
      expect(await d.executeCommand(`${frappe} ${haut}`), `${frappe} ${haut}`)
        .not.toMatch(/Invalid|Incomplete/);
      expect(await d.executeCommand(`${frappe} ${Number(haut) + 1}`),
        `${frappe} ${Number(haut) + 1}`).toMatch(/Invalid input/);
    });
  });

  describe(`ce qui est pose se relit, sur un ${plateforme}`, () => {
    it('les six reglages traversent `show running-config`', async () => {
      const d = await enConfig(fabrique,
        'ip domain name labo.net',
        'ip domain-list secours.net',
        'ip name-server 10.0.0.53',
        'ip domain retry 4',
        'ip domain timeout 7',
        'ip host serveur 10.0.0.9');
      const texte = await config(d);
      for (const attendu of [/ip domain[- ]name labo\.net/, /ip domain[- ]list secours\.net/,
        /ip name-server 10\.0\.0\.53/, /ip domain retry 4/, /ip domain timeout 7/,
        /ip host serveur 10\.0\.0\.9/]) {
        expect(texte, String(attendu)).toMatch(attendu);
      }
    });
  });
}

describe('les deux plateformes decrivent ce resolveur pareil', () => {
  const PLACES: readonly string[] = [
    'ip domain ', 'ip domain name ', 'ip domain retry ', 'ip domain timeout ',
    'ip dns ', 'ip name-server ', 'ip host ', 'ip domain-name ', 'ip domain-list ',
  ];
  for (const place of PLACES) {
    it(`\`${place}?\``, async () => {
      const r = await enConfig(FABRIQUES[0][1]);
      const s = await enConfig(FABRIQUES[1][1]);
      expect(s.cliHelp(place)).toBe(r.cliHelp(place));
    });
  }
});
