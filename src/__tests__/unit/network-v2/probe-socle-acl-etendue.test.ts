/*
 * Sonde ECRITE A L'AVEUGLE sur `permit`/`deny` dans une liste d'acces
 * ETENDUE, avant toute lecture de leur declaration.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. L'autorite employee est donc celle que le depot porte ET
 * APPLIQUE — les tables que le moteur consulte pour decider :
 *   `IP_PROTOCOL_KEYWORDS`  les quinze protocoles nommes, plus <0-255>
 *   `PORT_KEYWORDS`         les noms de port
 *   `isAclPortOperator`     eq, neq, gt, lt, range
 * La sonde les LIT plutot que d'en recopier un extrait : recopier, ici,
 * serait refaire exactement la faute qu'elle mesure.
 *
 * L'invariant est celui du depot : ce que la machine ACCEPTE, elle
 * l'ANNONCE, et ce qu'elle annonce, elle l'execute. Une liste etendue
 * est l'endroit ou il coute le plus cher — c'est la grammaire la plus
 * riche de la CLI, donc celle ou l'operateur depend le plus de `?`.
 *
 * Discriminee contre l'etat d'avant : 38 des 125 cas tombent, DIX-NEUF
 * par plateforme — la symetrie exacte dit que le sous-mode etait bien
 * commun, et le defaut avec lui. Les 87 autres sont nommes ici :
 *
 *   - les vingt-six formes POSEES et les quatre REFUSEES passaient
 *     deja. C'est `parseCiscoAce` qui les tranche et ce lot ne le
 *     deplace pas : elles sont les TEMOINS de ce qu'une migration ne
 *     doit PAS perdre. Le glouton du trie acceptait toute la queue
 *     d'une ACE ; une declaration par places typees ne la rend qu'a
 *     condition de l'avoir declaree, et neuf d'entre elles sont ecrites
 *     pour cela — `ttl eq 255`, `ttl range 1 64`, `option any-options`,
 *     `match-all +syn -ack`, `match-any rst`, `reflect MIROIR timeout
 *     120`, `icmp any any 8 0`, `tos min-delay`, `range 1 100`. Trois
 *     tombaient au premier jet du lot, ce que la discrimination ne
 *     montre pas et que seul le fait de les avoir ecrites a revele ;
 *   - `permit tcp any eq 80 any` garde le port SOURCE, la ou une place
 *     mal comptee aurait refuse le second ;
 *   - `permit 47 any any` relu `permit gre any any` est le TEMOIN du
 *     protocole numerique : la place migree porte ses mots-cles ET sa
 *     plage, et n'offrir que les mots aurait refuse le numero ;
 *   - `no permit ip any any`, `evaluate MIROIR` et `permit ip any`
 *     INCOMPLET sont les VOISINS du chemin migre — ils disent qu'on ne
 *     les a pas emportes ;
 *   - `permit ?` sans `<cr>`, et `permit tcp ?` / `permit ip ?` qui
 *     annoncaient deja quatre formes : le trie repondait juste au
 *     PREMIER pas. C'est APRES la source que tout se defaisait ;
 *   - `permit ip any any ?` sans operateur de port passait a VIDE :
 *     l'ancien arbre n'annoncait rien du tout a cette place, donc
 *     l'absence de `eq` n'y prouvait rien. Le cas reste parce qu'il
 *     devient discriminant maintenant que la place parle ;
 *   - les sept comparaisons entre plateformes passaient : les deux
 *     etaient fausses de la MEME facon. Elles ne sont pas decoratives —
 *     elles ont CASSE en cours de lot, quand la table d'aide du trie
 *     s'est mise a decrire `permit ip` sur le seul Catalyst, et c'est
 *     leur rupture qui a montre que cette table etait posee avant
 *     l'elagage d'un cote et apres de l'autre.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import {
  IP_PROTOCOL_KEYWORDS, PORT_KEYWORDS,
} from '@/network/devices/router/acl/AclSyntax';
import { DSCP_KEYWORD_TO_VALUE } from '@/network/devices/router/ACLEngine';

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

let serie = 0;

const FABRIQUES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`X${serie++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli],
];

async function etendue(fabrique: () => Cli): Promise<Cli> {
  const d = fabrique();
  d.powerOn();
  for (const c of ['enable', 'configure terminal', 'ip access-list extended EL']) {
    await d.executeCommand(c);
  }
  return d;
}

async function conf(d: Cli): Promise<string> {
  await d.executeCommand('end');
  return d.executeCommand('show running-config');
}

const FORMES_ADRESSE = ['any', 'host', 'object-group', 'A.B.C.D'] as const;
const OPERATEURS = ['eq', 'neq', 'gt', 'lt', 'range'] as const;

/** Les places ou une DESTINATION est attendue, et rien d'autre. */
const AVANT_LA_DESTINATION: readonly string[] = [
  'permit tcp any ',
  'permit tcp host 10.0.0.1 ',
  'permit ip any ',
  'permit tcp any eq 80 ',
];

for (const [plateforme, fabrique] of FABRIQUES) {
  describe(`le PROTOCOLE d une liste etendue, sur un ${plateforme}`, () => {
    it('`permit ?` annonce les quinze protocoles que le moteur lit', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit '));
      for (const proto of Object.keys(IP_PROTOCOL_KEYWORDS)) {
        expect(rendus, `permit ? tait ${proto}`).toContain(proto);
      }
    });

    it('`permit ?` n annonce PAS les formes d une liste standard', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit '));
      for (const forme of ['any', 'host']) {
        expect(rendus, `permit ? offre ${forme}, qui n a pas de protocole`)
          .not.toContain(forme);
      }
    });

    it('`permit ?` ne promet pas de `<cr>`', async () => {
      const d = await etendue(fabrique);
      expect(annonceCr(d.cliHelp('permit '))).toBe(false);
      expect(await d.executeCommand('permit')).toMatch(/Incomplete command/);
    });

    it('un protocole NUMERIQUE reste accepte et se nomme', async () => {
      const d = await etendue(fabrique);
      expect(await d.executeCommand('permit 47 any any')).not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('permit gre any any');
    });
  });

  describe(`la SOURCE et la DESTINATION, sur un ${plateforme}`, () => {
    for (const place of ['permit tcp ', 'permit ip ', ...AVANT_LA_DESTINATION]) {
      it(`\`${place}?\` annonce les quatre formes d adresse`, async () => {
        const d = await etendue(fabrique);
        const rendus = mots(d.cliHelp(place));
        for (const forme of FORMES_ADRESSE) {
          expect(rendus, `${place}? tait ${forme}`).toContain(forme);
        }
      });
    }

    for (const place of AVANT_LA_DESTINATION) {
      it(`\`${place}?\` ne promet pas de \`<cr>\` — il manque la destination`, async () => {
        const d = await etendue(fabrique);
        expect(annonceCr(d.cliHelp(place))).toBe(false);
        expect(await d.executeCommand(place.trim())).toMatch(/Incomplete command/);
      });
    }

    it('`permit tcp host <ip> ?` annonce bien une destination', async () => {
      const d = await etendue(fabrique);
      expect(mots(d.cliHelp('permit tcp host 10.0.0.1 '))).toContain('any');
    });
  });

  describe(`les PORTS d une liste etendue, sur un ${plateforme}`, () => {
    it('`permit tcp any any ?` annonce les CINQ operateurs', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit tcp any any '));
      for (const op of OPERATEURS) {
        expect(rendus, `permit tcp any any ? tait ${op}`).toContain(op);
      }
    });

    it('`permit tcp any any eq ?` annonce les noms de port du moteur', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit tcp any any eq '));
      for (const nom of ['www', 'ssh', 'https', 'domain', 'smtp']) {
        expect(rendus, `eq ? tait ${nom}`).toContain(nom);
        expect(PORT_KEYWORDS[nom]).toBeTypeOf('number');
      }
    });

    it('`permit ip any any ?` n annonce AUCUN operateur de port', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit ip any any '));
      for (const op of OPERATEURS) {
        expect(rendus, `ip n a pas de port, et ? offre ${op}`).not.toContain(op);
      }
    });

    it('`range` prend DEUX ports', async () => {
      const d = await etendue(fabrique);
      expect(await d.executeCommand('permit tcp any any range 1 100'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('permit tcp any any range 1 100');
    });

    it('un port SOURCE reste accepte', async () => {
      const d = await etendue(fabrique);
      expect(await d.executeCommand('permit tcp any eq 80 any'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).toContain('permit tcp any eq 80 any');
    });
  });

  describe(`les SUFFIXES d une liste etendue, sur un ${plateforme}`, () => {
    const SUFFIXES = ['log', 'log-input', 'fragments', 'time-range',
      'dscp', 'precedence', 'tos', 'reflect'] as const;

    it('`permit ip any any ?` annonce ce que le moteur lit ensuite', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit ip any any '));
      for (const suffixe of SUFFIXES) {
        expect(rendus, `permit ip any any ? tait ${suffixe}`).toContain(suffixe);
      }
    });

    it('`established` est annonce pour TCP', async () => {
      const d = await etendue(fabrique);
      expect(mots(d.cliHelp('permit tcp any any '))).toContain('established');
    });

    it('un type ICMP est annonce apres `permit icmp any any`', async () => {
      const d = await etendue(fabrique);
      expect(mots(d.cliHelp('permit icmp any any '))).toContain('echo');
    });

    it('`ttl ?` annonce les CINQ operateurs, comme un port', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit ip any any ttl '));
      for (const op of OPERATEURS) {
        expect(rendus, `ttl ? tait ${op}`).toContain(op);
      }
    });

    it('`dscp ?` annonce les mots que le moteur TRADUIT', async () => {
      const d = await etendue(fabrique);
      const rendus = mots(d.cliHelp('permit ip any any dscp '));
      for (const nom of Object.keys(DSCP_KEYWORD_TO_VALUE)) {
        expect(rendus, `dscp ? tait ${nom}`).toContain(nom);
      }
    });

    it('`match-any ?` n est annonce que pour TCP, avec ses drapeaux', async () => {
      const d = await etendue(fabrique);
      expect(mots(d.cliHelp('permit tcp any any '))).toContain('match-any');
      expect(mots(d.cliHelp('permit udp any any ')), 'udp n a pas de drapeaux')
        .not.toContain('match-any');
      expect(mots(d.cliHelp('permit tcp any any match-any '))).toContain('syn');
    });

    it('`established` n est annonce que pour TCP', async () => {
      const d = await etendue(fabrique);
      expect(mots(d.cliHelp('permit udp any any '))).not.toContain('established');
    });
  });

  describe(`ce qu une liste etendue accepte reste accepte, sur un ${plateforme}`, () => {
    const POSEES: ReadonlyArray<readonly [string, string]> = [
      ['permit ip any any', 'permit ip any any'],
      ['deny tcp any any eq 80', 'deny tcp any any eq 80'],
      ['permit tcp any any eq www', 'permit tcp any any eq 80'],
      ['permit tcp any any eq ssh', 'permit tcp any any eq 22'],
      ['permit icmp any any echo', 'permit icmp any any echo'],
      ['permit ip host 10.0.0.1 any', 'permit ip host 10.0.0.1 any'],
      ['permit tcp 10.0.0.0 0.0.0.255 any eq 22', 'permit tcp 10.0.0.0 0.0.0.255 any eq 22'],
      ['permit ip any any log', 'permit ip any any log'],
      ['permit tcp any any established', 'permit tcp any any established'],
      ['permit gre any any', 'permit gre any any'],
      ['permit ospf any any', 'permit ospf any any'],
      ['permit tcp any any neq 22', 'permit tcp any any neq 22'],
      ['permit tcp any any gt 1024', 'permit tcp any any gt 1024'],
      ['permit ip any any dscp ef', 'permit ip any any dscp ef'],
      ['permit ip any any fragments', 'permit ip any any fragments'],
      ['permit ip object-group G any', 'permit ip object-group G any'],
      ['permit ip any any precedence critical', 'permit ip any any precedence critical'],
      ['permit ip any any ttl eq 255', 'permit ip any any ttl eq 255'],
      ['permit ip any any ttl range 1 64', 'permit ip any any ttl range 1 64'],
      ['permit ip any any option any-options', 'permit ip any any option any-options'],
      ['permit icmp any any 8 0', 'permit icmp any any echo'],
      ['permit tcp any any match-all +syn -ack', 'permit tcp any any match-all +syn -ack'],
      ['deny tcp any any match-any rst', 'deny tcp any any match-any rst'],
      ['permit ip any any reflect MIROIR timeout 120',
        'permit ip any any reflect MIROIR timeout 120'],
      ['permit ip any any tos min-delay', 'permit ip any any tos min-delay'],
    ];
    for (const [saisie, rendu] of POSEES) {
      it(`\`${saisie}\` — le TEMOIN`, async () => {
        const d = await etendue(fabrique);
        expect(await d.executeCommand(saisie)).not.toMatch(/Invalid|Incomplete/);
        expect(await conf(d)).toContain(` ${rendu}`);
      });
    }

    const REFUSEES: readonly string[] = [
      'permit zorglub any any',
      'permit ip any any zorglub',
      'permit ip zorglub any',
      'permit tcp any any eq zorglub',
    ];
    for (const saisie of REFUSEES) {
      it(`\`${saisie}\` est refusee`, async () => {
        const d = await etendue(fabrique);
        expect(await d.executeCommand(saisie)).toMatch(/Invalid input/);
        expect(await conf(d)).not.toContain('zorglub');
      });
    }

    it('`permit ip any` est INCOMPLET', async () => {
      const d = await etendue(fabrique);
      expect(await d.executeCommand('permit ip any')).toMatch(/Incomplete command/);
    });

    it('`no permit ip any any` retire — le TEMOIN de la negation', async () => {
      const d = await etendue(fabrique);
      await d.executeCommand('permit ip any any');
      expect(await d.executeCommand('no permit ip any any'))
        .not.toMatch(/Invalid|Incomplete/);
      expect(await conf(d)).not.toContain('permit ip any any');
    });

    it('`evaluate` reste la — le TEMOIN du voisin', async () => {
      const d = await etendue(fabrique);
      expect(await d.executeCommand('evaluate MIROIR')).not.toMatch(/Invalid|Incomplete/);
    });
  });
}

describe('les deux plateformes decrivent une liste etendue avec les memes mots', () => {
  const PLACES: readonly string[] = [
    'permit ', 'permit tcp ', 'permit tcp any ', 'permit tcp any any ',
    'permit tcp any any eq ', 'permit ip any any ', 'permit icmp any any ',
  ];
  for (const place of PLACES) {
    it(`\`${place}?\``, async () => {
      const r = await etendue(FABRIQUES[0][1]);
      const s = await etendue(FABRIQUES[1][1]);
      expect(s.cliHelp(place)).toBe(r.cliHelp(place));
    });
  }
});
