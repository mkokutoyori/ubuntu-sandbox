/*
 * Sonde ECRITE A L'AVEUGLE sur quatre commandes d'EXEC privilegie que
 * les DEUX plateformes Cisco portent : `disable`, `reload`, `send` et
 * `undebug`.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande donc aucune citation :
 *
 *   1. un routeur et un Catalyst sont la MEME CLI. La meme frappe, au
 *      meme endroit, rend le meme mot — c'est la regle que ce depot
 *      applique partout ailleurs, et ces quatre commandes ne sont pas
 *      des commandes de plateforme ;
 *   2. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   3. ce que `?` annonce s'EXECUTE.
 *
 * La seule chose qui vienne d'IOS est la forme de `disable` : elle
 * prend un NIVEAU facultatif (`disable [<0-15>]`), et sans lui elle
 * redescend au niveau 1. C'est ce que la commande fait deja ici, sans
 * accepter le niveau — le laboratoire ci-dessous le mesure plutot que
 * de l'affirmer.
 *
 * POURQUOI CES QUATRE-LA : `undebug` n'etait PAS une commande dans ce
 * simulateur — c'etait une REECRITURE de texte devant l'analyseur, qui
 * transformait `undebug X` en `no debug X`. Les deux plateformes la
 * completaient chacune avec son propre noeud, et ces noeuds ne disaient
 * pas la meme chose. `send` et `reload` etaient des noeuds GLOUTONS dont
 * l'aide se derivait d'une liste posee a cote.
 *
 * Discriminee contre l'etat d'avant : 13 des 44 cas tombent. Les 31 qui
 * passent des deux cotes sont nommes :
 *
 *   - `disable` redescendait deja, `disable 42` etait deja refuse et
 *     `disable ?` promettait deja un `<cr>` qui tient. Ce sont les
 *     TEMOINS : la place de niveau devait s'ANNONCER sans rien changer
 *     de ce que la commande faisait deja — le repartiteur lisait le
 *     niveau, seule l'aide l'ignorait ;
 *   - `reload ?` annoncait deja ses trois suites, `reload in 5` et
 *     `reload cancel` marchaient deja, `reload in zorglub` etait deja
 *     refuse. Le seul ecart de cette famille est le rang : le glouton
 *     offrait ses freres a toutes les profondeurs, donc `reload in ?`
 *     proposait `at` et `cancel` — et un `<cr>` pour une frappe que la
 *     meme machine declare incomplete ;
 *   - les quatre cas de `send` passent des deux cotes : cette
 *     famille-la n'avait pas de defaut mesurable a la racine, et elle
 *     entre au socle pour que sa grammaire soit ECRITE UNE FOIS —
 *     `sendTargetOf` lit desormais le chemin canonique au lieu de
 *     redecouper la ligne pour son propre compte ;
 *   - `undebug ?` annoncait deja `all` SUR LE ROUTEUR — son noeud
 *     s'appelait litteralement `undebug all` — et `undebug all` comme
 *     `undebug arp` s'executaient deja. Ce sont les TEMOINS de la
 *     reecriture : ce qui change n'est pas ce que la commande FAIT,
 *     c'est qu'elle cesse d'etre ecrite trois fois ;
 *   - « chaque mot que `undebug ?` annonce s EXECUTE » passait avant
 *     pour une raison STRUCTURELLE et non par vertu : le routeur
 *     n'annoncait qu'un mot, et le `WORD` du commutateur est ecarte par
 *     le filtre des substituts. Le balayage ne mesurait rien ; il mesure
 *     quarante mots maintenant, et c'est lui qui a fait tomber le
 *     vocabulaire de routeur qu'un Catalyst annoncait sans le savoir
 *     faire ;
 *   - les quatre comparaisons entre plateformes passaient deja : les
 *     quatre commandes etaient enregistrees dans la classe PARTAGEE.
 *     Elles sont ici la NON-REGRESSION de la migration — une famille qui
 *     part au socle par un seul cote est exactement ce qui creuse
 *     l'ecart que `undebug` avait fini par creuser.
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
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function privilegie(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  await d.executeCommand('enable');
  return d;
}

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`\`disable\`, sur un ${plateforme}`, () => {
    it('redescend en mode utilisateur', async () => {
      const d = await privilegie(fabrique);
      expect(d.getPrompt()).toMatch(/#$/);
      expect(await d.executeCommand('disable')).not.toMatch(/Invalid|Incomplete/);
      expect(d.getPrompt()).toMatch(/>$/);
    });

    it('prend un NIVEAU, et son aide l annonce', async () => {
      const d = await privilegie(fabrique);
      expect(mots(d.cliHelp('disable '))).toContain('<0-15>');
      expect(await d.executeCommand('disable 1')).not.toMatch(/Invalid|Incomplete/);
      expect(d.getPrompt()).toMatch(/>$/);
    });

    it('refuse un niveau hors plage', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('disable 42')).toMatch(/Invalid input/);
    });

    it('promet un `<cr>` qui tient — le TEMOIN', async () => {
      const d = await privilegie(fabrique);
      expect(annonceCr(d.cliHelp('disable '))).toBe(true);
    });
  });

  describe(`\`reload\`, sur un ${plateforme}`, () => {
    it('`reload ?` annonce ses trois suites', async () => {
      const d = await privilegie(fabrique);
      const rendus = mots(d.cliHelp('reload '));
      for (const mot of ['at', 'cancel', 'in']) {
        expect(rendus, `reload ? tait ${mot}`).toContain(mot);
      }
    });

    it('`reload in ?` demande des minutes, sans `<cr>` menteur', async () => {
      const d = await privilegie(fabrique);
      expect(annonceCr(d.cliHelp('reload in '))).toBe(false);
      expect(await d.executeCommand('reload in')).toMatch(/Incomplete command/);
    });

    it('`reload in 5` planifie, `reload cancel` annule — les TEMOINS', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('reload in 5')).toMatch(/5 minutes/);
      expect(await d.executeCommand('reload cancel')).toMatch(/cancelled/i);
    });

    it('`reload in zorglub` est refuse', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('reload in zorglub')).toMatch(/Invalid input/);
    });
  });

  describe(`\`send\`, sur un ${plateforme}`, () => {
    it('`send ?` annonce ses cibles', async () => {
      const d = await privilegie(fabrique);
      const rendus = mots(d.cliHelp('send '));
      for (const cible of ['*', 'console', 'vty']) {
        expect(rendus, `send ? tait ${cible}`).toContain(cible);
      }
    });

    it('`send` seul est INCOMPLET, sans `<cr>` menteur', async () => {
      const d = await privilegie(fabrique);
      expect(annonceCr(d.cliHelp('send '))).toBe(false);
      expect(await d.executeCommand('send')).toMatch(/Incomplete command/);
    });

    it('`send *` est accepte — le TEMOIN', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('send *')).not.toMatch(/Invalid|Incomplete/);
    });

    it('`send zorglub` est refuse', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('send zorglub')).toMatch(/Invalid input/);
    });
  });

  describe(`\`undebug\`, sur un ${plateforme}`, () => {
    it('`undebug ?` annonce `all`', async () => {
      const d = await privilegie(fabrique);
      expect(mots(d.cliHelp('undebug '))).toContain('all');
    });

    it('`undebug` seul est INCOMPLET, sans `<cr>` menteur', async () => {
      const d = await privilegie(fabrique);
      expect(annonceCr(d.cliHelp('undebug '))).toBe(false);
      expect(await d.executeCommand('undebug')).toMatch(/Incomplete command/);
    });

    it('`undebug all` eteint tout — le TEMOIN', async () => {
      const d = await privilegie(fabrique);
      await d.executeCommand('debug arp');
      expect(await d.executeCommand('undebug all')).not.toMatch(/Invalid|Incomplete/);
      expect(await d.executeCommand('show debugging')).not.toMatch(/ARP packet/i);
    });

    it('`undebug arp` vaut `no debug arp` — le TEMOIN de la reecriture', async () => {
      const d = await privilegie(fabrique);
      await d.executeCommand('debug arp');
      expect(await d.executeCommand('undebug arp')).not.toMatch(/Invalid|Incomplete/);
      expect(await d.executeCommand('show debugging')).not.toMatch(/ARP packet/i);
    });

    it('chaque mot que `undebug ?` annonce s EXECUTE', async () => {
      const d = await privilegie(fabrique);
      for (const mot of mots(d.cliHelp('undebug '))) {
        if (mot === '<cr>' || /^[<A-Z]/.test(mot)) continue;
        expect(await d.executeCommand(`undebug ${mot}`), `undebug ${mot}`)
          .not.toMatch(/Invalid input/);
      }
    });
  });
}

describe('les deux plateformes decrivent ces quatre commandes pareil', () => {
  const PLACES: readonly string[] = [
    'disable ', 'reload ', 'reload in ', 'send ',
  ];
  for (const place of PLACES) {
    it(`\`${place}?\``, async () => {
      const r = await privilegie(FABRIQUES[0][1]);
      const s = await privilegie(FABRIQUES[1][1]);
      expect(s.cliHelp(place)).toBe(r.cliHelp(place));
    });
  }
});

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`\`undebug ?\` EST \`no debug ?\`, sur un ${plateforme}`, () => {
    it('mot pour mot, a la racine', async () => {
      const d = await privilegie(fabrique);
      expect(d.cliHelp('undebug ')).toBe(d.cliHelp('no debug '));
    });

    it('mot pour mot, sous `ip`', async () => {
      const d = await privilegie(fabrique);
      expect(d.cliHelp('undebug ip ')).toBe(d.cliHelp('no debug ip '));
    });

    it('`undebug` seul repond comme `no debug` seul', async () => {
      const d = await privilegie(fabrique);
      expect(await d.executeCommand('undebug'))
        .toBe(await d.executeCommand('no debug'));
    });
  });
}
