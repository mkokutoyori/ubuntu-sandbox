/*
 * `ping` et `traceroute` etaient declares en GLOUTON sur quatre arbres —
 * l'arbre utilisateur et l'arbre privilegie, du routeur et du Catalyst —
 * avec une liste de mots-cles de completion PLATE a cote. Une liste
 * plate ne sait pas qu'un mot-cle DOIT une valeur, d'ou la famille de
 * mensonges que cette sonde ferme.
 *
 * Mesure, avant correctif (routeur, EXEC utilisateur) :
 *
 *   ping 10.0.0.1 repeat ?   ->  size / source / timeout / <cr>
 *   ping repeat size ?       ->  source / timeout / <cr>
 *   traceroute 10.0.0.1 probe ?  ->  timeout / ttl / <cr>
 *   traceroute probe ttl ?   ->  timeout / <cr>
 *
 * Apres `repeat`, IOS n'annonce QUE la valeur attendue —
 * `<1-2147483647>  Repeat count` — parce que la commande ne se valide
 * pas la et qu'aucune autre option ne peut s'intercaler. Ici l'aide
 * proposait les options SUIVANTES et un `<cr>` que la frappe refuse :
 * `ping 10.0.0.1 repeat` repond `% Incomplete command.`
 *
 * Deuxieme ecart, entre les deux modes EXEC de la MEME machine :
 *
 *   Routeur, privilegie :  ping ?  ->  WORD  Destination address or hostname
 *   Routeur, utilisateur : ping ?  ->  (aucune place annoncee)
 *
 * La place de la destination n'etait decrite que sur l'arbre privilegie
 * (`ciscoArgumentHelp`, `tries.privileged.describeArgs`), alors que la
 * commande existe dans les deux modes. Une seule declaration, lue par
 * les deux modes, est exactement ce que le socle apporte.
 *
 * Troisieme ecart, entre les deux PLATEFORMES :
 *
 *   Routeur  : ping 10.0.0.1 ?  ->  repeat / size / source / timeout
 *   Catalyst : ping 10.0.0.1 ?  ->  WORD  Send echo messages
 *
 * Le Catalyst n'annoncait AUCUNE option — et le `WORD` portait la
 * description de la COMMANDE au lieu de celle de la place. Il les
 * acceptait pourtant toutes : `handlePing` appelle le meme
 * `parsePingArgs` que le routeur. L'aide et l'execution se
 * contredisaient sur la meme machine au meme instant.
 *
 * Quatrieme : la taille de datagramme n'etait bornee NULLE PART.
 * `ping 10.0.0.1 size 20` partait, alors que la documentation de Cisco
 * donne 36-18024 — la meme paire que le balayage de ce depot porte
 * depuis toujours dans ses valeurs par defaut (`Sweep min size [36]`,
 * `Sweep max size [18024]`). Une plage annoncee est une plage
 * appliquee ; celle-la n'etait ni l'une ni l'autre.
 *
 * Bornes retenues, et leur source : `repeat` 1-2147483647 et `size`
 * 36-18024 viennent de la documentation de Cisco. `timeout`, `probe` et
 * `ttl` n'ont pas de plage ANNONCEE ici, parce que ce reseau n'a pas pu
 * en atteindre la source — support/cisco.com est bloque au
 * telechargement par le mandataire de sortie — et qu'annoncer une plage
 * inventee serait pire que n'en annoncer aucune. Le controle qui
 * existait (un entier strictement positif) est conserve.
 *
 * Ce que ce lot ne ferme PAS, et qui est dit ici plutot que taire :
 * `parsePingArgs` reste le lecteur de la ligne pour la COUCHE TERMINAL
 * (le ping qui peint ses `!` au fil de l'eau, et le dialogue de ping
 * etendu), qui recoit une ligne brute et non les places typees du
 * socle. Deux lecteurs d'une meme grammaire subsistent donc le temps
 * d'un lot. Le suivant les ramene a un seul en faisant demander au
 * terminal ce que le socle a deja analyse — c'est le meme lot qui donne
 * au Catalyst le ping progressif et le dialogue etendu, tous deux
 * fermes aujourd'hui par un `instanceof Router`.
 *
 * `df-bit`, `data` et `validate` ne sont pas declares : le chemin du
 * shell ne sait pas les honorer (seul le dialogue etendu pose DF), et
 * un critere que le moteur n'evalue pas ne se declare pas.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : 34 des 65 cas
 * tombent. Les 31 autres sont nommes :
 *
 *  - TEMOINS de grammaire : les sept formes de `ping` et les cinq de
 *    `traceroute` qui marchaient marchent encore, et les cinq refus qui
 *    marchaient refusent encore. Une migration qui casserait la commande
 *    en ferait tomber au moins un.
 *  - TEMOIN de plage : les quatre tailles legitimes (36, 100, 1500,
 *    18024) passent, sans quoi borner la taille a `[]` passerait pour un
 *    succes.
 *  - TEMOIN d'incompletude : `ping 10.0.0.1 repeat` repondait deja
 *    `% Incomplete command.` et doit continuer — c'est ce refus qui rend
 *    le `<cr>` annonce a cote mensonger, et le corriger ne doit pas
 *    consister a accepter la frappe.
 *  - TEMOIN de famille : `ping ?` annoncait deja `ip` et `ipv6` sur le
 *    routeur.
 *  - TEMOIN de plateforme : le Catalyst EXECUTAIT deja les options qu'il
 *    n'annoncait pas, et il ne connait toujours pas `traceroute` — le
 *    lot ne lui en invente pas un qu'aucun plan de donnees ne porte.
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

const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

const descriptionDe = (aide: string, mot: string): string | undefined => {
  for (const ligne of aide.split('\n')) {
    if (MOT.exec(ligne)?.[1] === mot) return ligne.trim().split(/\s{2,}/)[1];
  }
  return undefined;
};

let serie = 0;

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`R${serie++}`) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

async function catalyst(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `S${serie++}`, 8) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const MODES: ReadonlyArray<readonly [string, string[]]> = [
  ['EXEC utilisateur', []],
  ['EXEC privilegie', ['enable']],
];

describe('apres un mot-cle qui DOIT une valeur, l\'aide n\'annonce que la valeur', () => {
  describe.each(MODES)('%s', (_nom, prelude) => {
    it.each([
      'ping 10.0.0.1 repeat ',
      'ping 10.0.0.1 size ',
      'ping 10.0.0.1 timeout ',
      'ping 10.0.0.1 source ',
      'traceroute 10.0.0.1 probe ',
      'traceroute 10.0.0.1 timeout ',
      'traceroute 10.0.0.1 ttl ',
    ])('`%s?` ne promet pas `<cr>`', async (frappe) => {
      const d = await routeur(...prelude);
      expect(annonceCr(d.cliHelp(frappe)), `${frappe}?`).toBe(false);
    });

    it.each([
      ['ping 10.0.0.1 repeat ', ['size', 'source', 'timeout']],
      ['traceroute 10.0.0.1 probe ', ['timeout', 'ttl']],
    ] as Array<[string, string[]]>)(
      '`%s?` n\'annonce plus les options voisines', async (frappe, voisines) => {
        const d = await routeur(...prelude);
        const mots = motsDe(d.cliHelp(frappe));
        for (const voisine of voisines) {
          expect(mots, `${frappe}? propose ${voisine}`).not.toContain(voisine);
        }
      });

    it('`ping 10.0.0.1 repeat` reste bien INCOMPLET — le TEMOIN', async () => {
      const d = await routeur(...prelude);
      expect(await d.executeCommand('ping 10.0.0.1 repeat'))
        .toMatch(/Incomplete command/);
    });
  });
});

describe('la place de la destination est annoncee dans les DEUX modes EXEC', () => {
  describe.each(MODES)('%s', (_nom, prelude) => {
    it('`ping ?` annonce une place de destination', async () => {
      const d = await routeur(...prelude);
      expect(descriptionDe(d.cliHelp('ping '), 'WORD')).toBeTruthy();
    });

    it('`traceroute ?` annonce une place de destination', async () => {
      const d = await routeur(...prelude);
      expect(descriptionDe(d.cliHelp('traceroute '), 'WORD')).toBeTruthy();
    });

    it('`ping ?` annonce aussi les familles `ip` et `ipv6` — le TEMOIN', async () => {
      const d = await routeur(...prelude);
      expect(motsDe(d.cliHelp('ping '))).toEqual(expect.arrayContaining(['ip', 'ipv6']));
    });
  });
});

describe('le Catalyst annonce les memes options que le routeur', () => {
  describe.each(MODES)('%s', (_nom, prelude) => {
    it.each(['repeat', 'size', 'source', 'timeout'])(
      '`ping 10.0.0.1 ?` propose `%s`', async (option) => {
        const d = await catalyst(...prelude);
        expect(motsDe(d.cliHelp('ping 10.0.0.1 '))).toContain(option);
      });

    it('la place de destination ne porte plus la description de la commande', async () => {
      const d = await catalyst(...prelude);
      expect(descriptionDe(d.cliHelp('ping '), 'WORD'))
        .not.toMatch(/Send echo messages/);
    });

    it('et il les EXECUTE deja — le TEMOIN', async () => {
      const d = await catalyst(...prelude);
      expect(await d.executeCommand('ping 10.0.0.1 repeat 3'))
        .toMatch(/Sending 3,/);
    });
  });
});

describe('une plage annoncee est une plage appliquee', () => {
  it('`ping 10.0.0.1 size 20` est refuse — sous le minimum de 36', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('ping 10.0.0.1 size 20')).toMatch(/Invalid input/);
  });

  it('`ping 10.0.0.1 size 18025` est refuse — au-dessus de 18024', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('ping 10.0.0.1 size 18025')).toMatch(/Invalid input/);
  });

  it('`ping 10.0.0.1 size ?` annonce la plage qu\'il applique', async () => {
    const d = await routeur('enable');
    expect(motsDe(d.cliHelp('ping 10.0.0.1 size '))).toContain('<36-18024>');
  });

  it.each(['36', '100', '1500', '18024'])(
    '`ping 10.0.0.1 size %s` reste accepte — les TEMOINS', async (taille) => {
      const d = await routeur('enable');
      expect(await d.executeCommand(`ping 10.0.0.1 size ${taille}`))
        .toMatch(new RegExp(`Sending 5, ${taille}-byte`));
    });
});

describe('ce que la grammaire acceptait, elle l\'accepte encore', () => {
  it.each([
    ['ping 10.0.0.1', /Sending 5, 100-byte ICMP Echos to 10\.0\.0\.1/],
    ['ping ip 10.0.0.1', /Sending 5, 100-byte/],
    ['ping ipv6 2001:db8::1', /Sending 5, 100-byte ICMP Echos to 2001:db8::1/],
    ['ping 10.0.0.1 repeat 3', /Sending 3,/],
    ['ping 10.0.0.1 size 64 timeout 1', /Sending 5, 64-byte .*timeout is 1 seconds/],
    ['ping 10.0.0.1 source 1.1.1.1', /Sending 5,/],
    ['ping 10.0.0.1 timeout 1 repeat 2 size 64', /Sending 2, 64-byte/],
  ] as Array<[string, RegExp]>)('`%s` marche', async (ligne, attendu) => {
    const d = await routeur('enable');
    expect(await d.executeCommand(ligne), ligne).toMatch(attendu);
  });

  it.each([
    'ping 10.0.0.1 zorglub',
    'ping 10.0.0.1 repeat abc',
    'ping 10.0.0.1 repeat 0',
    'traceroute 10.0.0.1 zorglub',
    'traceroute 10.0.0.1 ttl 5 1',
  ])('`%s` reste refuse', async (ligne) => {
    const d = await routeur('enable');
    expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
  });

  it.each([
    ['ping 999.1.1.1', /Unrecognized host or address/],
    ['ping 10.0.0.1 repeat', /Incomplete command/],
    ['traceroute 10.0.0.1', /Tracing the route to 10\.0\.0\.1/],
    ['traceroute 10.0.0.1 probe 2', /Tracing the route/],
    ['traceroute 10.0.0.1 ttl 1 5', /Tracing the route/],
  ] as Array<[string, RegExp]>)('`%s` repond comme avant', async (ligne, attendu) => {
    const d = await routeur('enable');
    expect(await d.executeCommand(ligne), ligne).toMatch(attendu);
  });

  it('le Catalyst ne connait toujours pas `traceroute`', async () => {
    const d = await catalyst('enable');
    expect(await d.executeCommand('traceroute 10.0.0.1')).toMatch(/Translating/);
  });
});

describe('les deux commandes quittent les quatre arbres', () => {
  it.each([
    ['routeur', () => new CiscoRouter(`RX${serie++}`)],
    ['catalyst', () => new CiscoSwitch('switch-cisco', `SX${serie++}`, 8)],
  ] as Array<[string, () => unknown]>)('sur le %s', (_nom, faire) => {
    const shell = (faire() as { shell: Record<string, {
      enumerateExecutablePaths(): string[];
    }> }).shell;
    for (const nom of ['userTrie', 'privilegedTrie']) {
      const restants = shell[nom].enumerateExecutablePaths()
        .filter((p) => /^(ping|traceroute)\b/.test(p));
      expect(restants, `${nom} garde ${restants.join(', ')}`).toEqual([]);
    }
  });
});
