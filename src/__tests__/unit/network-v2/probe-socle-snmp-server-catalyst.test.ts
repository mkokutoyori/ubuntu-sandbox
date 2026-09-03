/**
 * Un Catalyst connait `snmp-server`, et ce qu'il accepte, il le SERT.
 *
 * Sonde ecrite AVANT lecture du code, contre la reference : un Catalyst
 * 2960/3560 est un agent SNMP, `snmp-server community` y est la premiere
 * commande de tout laboratoire de supervision, et `show snmp` y rend les
 * memes compteurs que sur un routeur.
 *
 * Mesure de depart, la meme configuration tapee sur les deux :
 *
 *   ROUTEUR     show snmp           -> Chassis: CH1 … contact … location
 *               show snmp community -> Community name: secretRO
 *               show snmp host      -> Notification host: 10.0.0.20
 *               running-config      -> les six lignes
 *
 *   CATALYST    show snmp           -> SNMP agent not enabled
 *               show snmp community -> SNMP agent not enabled
 *               show snmp host      -> SNMP agent not enabled
 *               running-config      -> RIEN
 *               chassis-id CH1      -> Chassis: FOC1235X78Z (inchange)
 *
 * Les douze mots-cles sont annonces par `?` sur le commutateur comme sur
 * le routeur, tous les six sont ACCEPTES en silence, et pas un n'est lu.
 * La consequence depasse l'affichage : la configuration rendue est
 * REJOUEE a l'import d'une topologie, donc un Catalyst supervise revient
 * vierge, sans que rien ne le dise.
 *
 * `SNMP agent not enabled` est le VRAI message d'IOS, et il est juste
 * tant que rien n'est configure — c'est le TEMOIN de cette sonde. Ce qui
 * est faux, c'est qu'il persiste APRES.
 *
 * Second volet, les deux plateformes : les places TYPEES de
 * `snmp-server host` sont annoncees et jamais jugees. IOS ecrit
 * `snmp-server host <hote> [vrf <nom>] [traps|informs]
 *  [version {1|2c|3 [auth|noauth|priv]}] <communaute>
 *  [udp-port <port>] [<type>]`. Deux premisses de cette sonde ont ete
 * CORRIGEES par la reference avant d'etre codees :
 *
 *   - apres `version 3`, un mot qui n'est aucun des trois niveaux est le
 *     NOM D'UTILISATEUR v3 — l'aide d'IOS l'annonce elle-meme
 *     (`WORD  SNMPv3 user name`). Juger cette place refuserait une forme
 *     que la vraie machine prend, donc elle reste libre ;
 *   - `udp-port` se tape APRES la communaute, et cette forme-la n'etait
 *     pas analysee du tout : les deux mots tombaient dans les types de
 *     notification. Chercher « 1162 » dans la vue passait donc sans rien
 *     prouver ; le cas exige `UDP port: 1162`.
 *
 * Troisieme volet, et il deborde SNMP : `?` refusait ce que la machine
 * accepte. La queue de `snmp-server host` est une place `REST`, et les
 * deux moteurs du socle ne la lisaient pas pareil — `parse` la laisse
 * avaler tout ce qui reste de la ligne, `locateCursor` avancait d'un
 * cran dans son noeud. Sur la MEME frappe, la machine acceptait
 * `version 2c public` et son aide repondait `% Invalid input detected`.
 * Toute place `REST` du socle l'avait. Corollaire pose en meme temps :
 * une forme DEJA tapee n'est plus offerte — c'est la regle que le
 * garde-fou `probe-cli-suggestions-never-repeat` porte depuis longtemps,
 * et rester sur la place `REST` la violait (`bgp default ?` reproposait
 * `default`).
 *
 * Discrimine par `git stash` sur les sept fichiers cables : 23 des 36
 * cas tombent avant correctif. Les 13 autres sont nommes ici plutot que
 * laisses a decouvrir, chacun avec sa raison de passer des deux cotes.
 *
 *   - les deux TEMOINS (machine neuve, « SNMP agent not enabled ») :
 *     c'est leur objet, ils disent que le message d'origine est JUSTE
 *     tant que rien n'est configure ;
 *   - « `version ?` ne refuse pas » : a CE rang l'aide rendait `<cr>`,
 *     donc elle ne refusait deja pas ; ce sont les rangs suivants qui
 *     refusaient, et ils sont dans la liste des rouges ;
 *   - « la frappe que l'aide accepte, la machine l'accepte aussi » et
 *     « la premiere place nomme les quatre suites » : gardes sur ce qui
 *     etait deja juste, ils existent pour que le correctif de l'aide ne
 *     le casse pas ;
 *   - « le commutateur annonce exactement la meme chose » : les deux
 *     plateformes partagent la declaration, donc leurs aides etaient
 *     deja identiques — y compris quand elles etaient fausses ;
 *   - les trois versions et les trois niveaux v3 acceptes, et « un mot
 *     libre est le nom d'utilisateur v3 » : ils bornent le refus, sans
 *     eux un analyseur qui refuserait TOUT satisferait la sonde ;
 *   - la non-regression du routeur : c'est ce que ce lot ne doit pas
 *     changer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = {
  cliHelp(s: string): string;
  executeCommand(c: string): Promise<string>;
};

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;
const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    out.push(String(await d.executeCommand(c)));
  }
  return out.slice(2);
}

const LABORATOIRE = [
  'snmp-server community secretRO RO',
  'snmp-server community secretRW RW',
  'snmp-server location SalleLab',
  'snmp-server contact admin@lab',
  'snmp-server chassis-id CH1',
  'snmp-server host 10.0.0.20 version 2c public',
];

async function montrer(d: Dev, vue: string): Promise<string> {
  return String(await d.executeCommand(`do ${vue}`));
}

const mots = (aide: string): string[] =>
  aide.split('\n').map((l) => /^\s\s(\S+)/.exec(l)?.[1]).filter((m): m is string => !!m);

const lignesSnmp = (cfg: string): string[] =>
  cfg.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('snmp-server'));

describe('TEMOIN — sans configuration, les deux disent la meme chose', () => {
  it('un commutateur neuf annonce que l agent n est pas actif', async () => {
    const s = commutateur('SWT');
    await conf(s);
    expect(await montrer(s, 'show snmp')).toContain('SNMP agent not enabled');
  });

  it('et un routeur neuf aussi', async () => {
    const r = routeur('RT');
    await conf(r);
    expect(await montrer(r, 'show snmp')).toContain('SNMP agent not enabled');
  });
});

describe('le Catalyst SERT ce qu il accepte', () => {
  it('`show snmp community` nomme la communaute configuree', async () => {
    const s = commutateur('SW1');
    await conf(s, ...LABORATOIRE);
    const vue = await montrer(s, 'show snmp community');
    expect(vue).not.toContain('SNMP agent not enabled');
    expect(vue).toContain('secretRO');
    expect(vue).toContain('secretRW');
  });

  it('`show snmp` rend le contact et la localisation', async () => {
    const s = commutateur('SW2');
    await conf(s, ...LABORATOIRE);
    const vue = await montrer(s, 'show snmp');
    expect(vue).toContain('admin@lab');
    expect(vue).toContain('SalleLab');
  });

  it('`snmp-server chassis-id` change le chassis rendu', async () => {
    const s = commutateur('SW3');
    await conf(s, ...LABORATOIRE);
    expect(await montrer(s, 'show snmp')).toContain('CH1');
  });

  it('`show snmp host` nomme l hote de notification', async () => {
    const s = commutateur('SW4');
    await conf(s, ...LABORATOIRE);
    const vue = await montrer(s, 'show snmp host');
    expect(vue).not.toContain('SNMP agent not enabled');
    expect(vue).toContain('10.0.0.20');
  });
});

describe('la configuration se RELIT', () => {
  it('les six lignes reviennent dans le running-config du commutateur', async () => {
    const s = commutateur('SW5');
    await conf(s, ...LABORATOIRE);
    const rendues = lignesSnmp(await montrer(s, 'show running-config'));
    for (const ligne of LABORATOIRE) {
      expect(rendues, ligne).toContain(ligne);
    }
  });

  it('et les deux plateformes rendent le MEME bloc pour la meme configuration', async () => {
    const r = routeur('RC');
    const s = commutateur('SC');
    await conf(r, ...LABORATOIRE);
    await conf(s, ...LABORATOIRE);
    expect(lignesSnmp(await montrer(s, 'show running-config')).sort())
      .toEqual(lignesSnmp(await montrer(r, 'show running-config')).sort());
  });

  it('`no snmp-server community` retire vraiment la communaute', async () => {
    const s = commutateur('SW6');
    await conf(s, ...LABORATOIRE, 'no snmp-server community secretRW');
    const vue = await montrer(s, 'show snmp community');
    expect(vue).toContain('secretRO');
    expect(vue).not.toContain('secretRW');
    expect(lignesSnmp(await montrer(s, 'show running-config')))
      .not.toContain('snmp-server community secretRW RW');
  });
});

describe('une place TYPEE de `snmp-server host` est jugee', () => {
  const MAUVAIS = [
    'snmp-server host 10.0.0.1 version zorglub public',
    'snmp-server host 10.0.0.1 public udp-port zorglub',
    'snmp-server host 10.0.0.1 public udp-port 99999',
    'snmp-server host 10.0.0.1 udp-port 70000 public',
  ];

  it.each(MAUVAIS)('le routeur refuse `%s`', async (cmd) => {
    const r = routeur(`RM${MAUVAIS.indexOf(cmd)}`);
    const [out] = await conf(r, cmd);
    expect(out).toContain('Invalid input');
  });

  it.each(MAUVAIS)('le commutateur refuse `%s`', async (cmd) => {
    const s = commutateur(`SM${MAUVAIS.indexOf(cmd)}`);
    const [out] = await conf(s, cmd);
    expect(out).toContain('Invalid input');
  });

  it('et un refus ne laisse RIEN dans la configuration', async () => {
    const r = routeur('RV');
    await conf(r, ...MAUVAIS);
    expect(lignesSnmp(await montrer(r, 'show running-config'))).toEqual([]);
  });

  it.each(['1', '2c', '3'])('les versions d IOS restent acceptees (%s)', async (v) => {
    const r = routeur(`RA${v}`);
    const [out] = await conf(r, `snmp-server host 10.0.0.1 version ${v} public`);
    expect(out).not.toContain('Invalid input');
  });

  it.each(['auth', 'noauth', 'priv'])('les trois niveaux v3 restent acceptes (%s)', async (n) => {
    const r = routeur(`RN${n}`);
    const [out] = await conf(r, `snmp-server host 10.0.0.1 version 3 ${n} Secret`);
    expect(out).not.toContain('Invalid input');
  });

  it('un port valide est accepte, HONORE et rendu la ou IOS l ecrit', async () => {
    const r = routeur('RP');
    const [out] = await conf(r, 'snmp-server host 10.0.0.1 public udp-port 1162');
    expect(out).not.toContain('Invalid input');
    expect(await montrer(r, 'show snmp host')).toContain('UDP port: 1162');
    expect(lignesSnmp(await montrer(r, 'show running-config')))
      .toContain('snmp-server host 10.0.0.1 version 1 public udp-port 1162');
  });

  it('apres `version 3`, un mot libre est le nom d utilisateur v3', async () => {
    const r = routeur('RU');
    const [out] = await conf(r, 'snmp-server host 10.0.0.1 version 3 monUtilisateur');
    expect(out).not.toContain('Invalid input');
    expect(await montrer(r, 'show snmp host')).toContain('monUtilisateur');
  });
});

describe('l aide et l analyse lisent la MEME place', () => {
  const PLUS_PROFOND = [
    'snmp-server host 10.0.0.1 version ',
    'snmp-server host 10.0.0.1 version 2c ',
    'snmp-server host 10.0.0.1 version 3 ',
    'snmp-server host 10.0.0.1 version 2c public ',
  ];

  it.each(PLUS_PROFOND)('`%s?` ne refuse pas', async (frappe) => {
    const r = routeur(`RH${PLUS_PROFOND.indexOf(frappe)}`);
    await conf(r);
    const aide = r.cliHelp(frappe);
    expect(aide).not.toContain('Invalid input');
    expect(mots(aide).length).toBeGreaterThan(0);
  });

  it('et la frappe que l aide accepte, la machine l accepte aussi', async () => {
    const r = routeur('RHX');
    const [out] = await conf(r, 'snmp-server host 10.0.0.1 version 2c public');
    expect(out).not.toContain('Invalid input');
  });

  it('la premiere place nomme les quatre suites d IOS', async () => {
    const r = routeur('RH9');
    await conf(r);
    expect(mots(r.cliHelp('snmp-server host 10.0.0.1 ')))
      .toEqual(expect.arrayContaining(['informs', 'traps', 'udp-port', 'version']));
  });

  it('une suite deja tapee n est plus proposee', async () => {
    const r = routeur('RHR');
    await conf(r);
    expect(mots(r.cliHelp('snmp-server host 10.0.0.1 version ')))
      .not.toContain('version');
    expect(mots(r.cliHelp('snmp-server host 10.0.0.1 traps version 2c public udp-port ')))
      .toEqual(['informs', '<cr>']);
  });

  it('le commutateur annonce exactement la meme chose', async () => {
    const r = routeur('RH4');
    const s = commutateur('SH4');
    await conf(r);
    await conf(s);
    for (const frappe of [
      'snmp-server ',
      'no snmp-server ',
      'snmp-server host 10.0.0.1 ',
      'snmp-server host 10.0.0.1 version ',
      'snmp-server community pub ',
    ]) {
      expect(mots(s.cliHelp(frappe)), frappe).toEqual(mots(r.cliHelp(frappe)));
    }
  });
});

describe('non-regression — le routeur garde ce qu il faisait deja', () => {
  it('ses six lignes sont toujours servies et rendues', async () => {
    const r = routeur('RR');
    await conf(r, ...LABORATOIRE);
    expect(await montrer(r, 'show snmp community')).toContain('secretRO');
    expect(await montrer(r, 'show snmp host')).toContain('10.0.0.20');
    expect(await montrer(r, 'show snmp')).toContain('CH1');
    expect(lignesSnmp(await montrer(r, 'show running-config')).length).toBe(LABORATOIRE.length);
  });

  it('`snmp-server enable traps` reste accepte et rendu des deux cotes', async () => {
    for (const d of [routeur('RE'), commutateur('SE')]) {
      await conf(d, 'snmp-server community public RO', 'snmp-server enable traps snmp linkdown');
      expect(lignesSnmp(await montrer(d, 'show running-config')))
        .toContain('snmp-server enable traps snmp linkdown');
    }
  });
});
