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

/*
 * SUITE — les TETES de la famille, ecrites A L'AVEUGLE depuis la
 * documentation IOS avant toute lecture du code.
 *
 * La sonde d'origine mesurait la forme `host` des deux commandes
 * heritees. Ce qui restait a mesurer est ce qui les PORTE : les cinq
 * reglages GLOBAUX (`timeout`, `retransmit`, `key`, `auth-port`,
 * `acct-port` cote RADIUS ; `timeout`, `port`, `key` cote TACACS+), la
 * forme NOMMEE moderne (`radius server <nom>` / `tacacs server <nom>`,
 * qui ouvre un sous-mode), et les formes en `no`.
 *
 * Discriminee contre l'etat d'avant : 33 des 144 cas tombent. Les
 * autres sont nommes ici plutot que laisses a decouvrir.
 *   - les 38 cas d'origine passaient deja, et le doivent : ils portent
 *     sur la forme `host`, corrigee par un lot anterieur ;
 *   - les cas de PLAGE (`radius-server timeout 1001`, `tacacs-server
 *     port 65536`…) passaient parce que le trie APPLIQUAIT la plage que
 *     ses continuations annoncaient. Ce qu'ils gardent est que la
 *     migration ne l'a pas perdue — la plage vit desormais sur la place
 *     declaree, lue par l'analyse et par l'aide ;
 *   - `radius-server auth-port 1812 zorglub` passait parce que cette
 *     forme-la, seule, controlait deja le mot de trop ; c'est
 *     `timeout`/`retransmit` qui ne le faisaient pas ;
 *   - les formes ACCEPTEES (`radius server RS1`, les six reglages
 *     globaux, `no … host`) passaient : le defaut n'etait pas qu'elles
 *     echouent, mais que leurs voisines malformees reussissent.
 *
 * Ce que la reference dit :
 *   `radius-server timeout <1-1000>` — secondes d'attente
 *   `radius-server retransmit <0-100>` — nombre de reprises
 *   `radius-server {auth-port|acct-port} <0-65535>`
 *   `tacacs-server timeout <1-1000>` / `tacacs-server port <1-65535>`
 *   `radius server <nom>` et `tacacs server <nom>` — le nom est EXIGE,
 *   c'est lui qui designe le serveur dans un groupe.
 */

const NOMMEES: ReadonlyArray<readonly [string, string]> = [
  ['radius', 'RS1'],
  ['tacacs', 'TS1'],
];

for (const [plateforme, fabrique] of PLATEFORMES) {
  for (const [mot, nom] of NOMMEES) {
    describe(`\`${mot} server <nom>\` sur un ${plateforme}`, () => {
      it('pose le serveur et se relit', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${mot} server ${nom}`)).not.toMatch(REFUS);
        expect(await conf(d)).toContain(`${mot} server ${nom}`);
      });

      it('sans nom, la commande est INCOMPLETE', async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${mot} server`))
          .toMatch(/Incomplete command/);
      });

      it(`\`${mot} zorglub\` est refuse, pas avale`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${mot} zorglub`)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });

      it('le sous-mode est bien celui du serveur nomme', async () => {
        const d = await fabrique();
        await d.executeCommand(`${mot} server ${nom}`);
        expect(await d.executeCommand('address ipv4 10.0.0.7'))
          .not.toMatch(REFUS);
        expect(await conf(d)).toContain('address ipv4 10.0.0.7');
      });
    });
  }
}

interface CasGlobal {
  readonly saisie: string;
  readonly hors: readonly string[];
}

const GLOBAUX: readonly CasGlobal[] = [
  { saisie: 'radius-server timeout 12', hors: ['radius-server timeout 1001', 'radius-server timeout 0'] },
  { saisie: 'radius-server retransmit 7', hors: ['radius-server retransmit 101'] },
  { saisie: 'radius-server auth-port 1812', hors: ['radius-server auth-port 65536'] },
  { saisie: 'radius-server acct-port 1813', hors: ['radius-server acct-port 65536'] },
  { saisie: 'tacacs-server timeout 12', hors: ['tacacs-server timeout 1001', 'tacacs-server timeout 0'] },
  { saisie: 'tacacs-server port 4949', hors: ['tacacs-server port 65536', 'tacacs-server port 0'] },
];

for (const [plateforme, fabrique] of PLATEFORMES) {
  describe(`les reglages GLOBAUX sur un ${plateforme}`, () => {
    for (const cas of GLOBAUX) {
      it(`\`${cas.saisie}\` est accepte`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(cas.saisie)).not.toMatch(REFUS);
      });

      for (const mauvais of cas.hors) {
        it(`\`${mauvais}\` sort de la plage ANNONCEE, donc refuse`, async () => {
          const d = await fabrique();
          expect(await d.executeCommand(mauvais)).toMatch(REFUS);
        });
      }

      const [tete, mot] = cas.saisie.split(' ');
      it(`\`${tete} ${mot} zorglub\` est refuse`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${tete} ${mot} zorglub`)).toMatch(REFUS);
      });

      it(`\`${cas.saisie} zorglub\` — un mot de trop est refuse`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${cas.saisie} zorglub`)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });
    }

    for (const tete of ['radius-server', 'tacacs-server'] as const) {
      it(`\`${tete} zorglub\` est refuse, pas avale`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${tete} zorglub`)).toMatch(REFUS);
        expect(await conf(d)).not.toMatch(/zorglub/);
      });

      it(`\`${tete}\` tout court est INCOMPLETE`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(tete)).toMatch(/Incomplete command/);
      });

      it(`\`no ${tete} zorglub\` est refuse`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`no ${tete} zorglub`)).toMatch(REFUS);
      });

      it(`\`${tete} key S3cret\` se pose et se relit`, async () => {
        const d = await fabrique();
        expect(await d.executeCommand(`${tete} key S3cret`)).not.toMatch(REFUS);
        expect(await conf(d)).toContain(`${tete} key S3cret`);
      });
    }

    it('`no radius-server host` retire le serveur pose', async () => {
      const d = await fabrique();
      await d.executeCommand('radius-server host 10.0.0.1 key S3cret');
      expect(await d.executeCommand('no radius-server host 10.0.0.1'))
        .not.toMatch(REFUS);
      expect(await conf(d)).not.toContain('radius-server host 10.0.0.1');
    });

    it('`no tacacs-server host` retire le serveur pose', async () => {
      const d = await fabrique();
      await d.executeCommand('tacacs-server host 10.0.0.2 key S3cret');
      expect(await d.executeCommand('no tacacs-server host 10.0.0.2'))
        .not.toMatch(REFUS);
      expect(await conf(d)).not.toContain('tacacs-server host 10.0.0.2');
    });
  });
}

describe('les deux plateformes repondent la MEME chose — les TETES', () => {
  const SAISIES = [
    'radius server', 'radius zorglub', 'tacacs server', 'tacacs zorglub',
    'radius-server', 'radius-server zorglub', 'no radius-server zorglub',
    'tacacs-server', 'tacacs-server zorglub', 'no tacacs-server zorglub',
    'radius-server timeout 1001', 'radius-server retransmit 101',
    'tacacs-server timeout 1001', 'tacacs-server port 65536',
    'radius-server timeout zorglub', 'tacacs-server port zorglub',
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
