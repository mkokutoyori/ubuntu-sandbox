/**
 * PRD-CLI-Fidelite-VRP.md §24 / lot V15 — VRRP : un magasin, une
 * grammaire, une vue.
 *
 * Comme les lots V11 a V14, ce fichier compare les deux plateformes
 * ENTRE ELLES pour le meme objet, plutot que chacune contre une maquette
 * recopiee. C'est ce qui rend le constat verifiable sans connaitre VRP :
 * quelle que soit la bonne reponse, un routeur et un commutateur ne
 * peuvent pas en donner deux differentes au meme groupe VRRP.
 *
 * Le defaut le plus lourd n'etait pas d'affichage. Pour la MEME commande
 * `vrrp vrid 1 track interface … reduced 30`, le commutateur baissait sa
 * priorite et le routeur non — son `track` n'atteignait jamais l'agent,
 * seulement une facade que personne ne faisait agir. C'est la raison
 * d'etre de la commande, et c'est le premier bloc ci-dessous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { analyserVrrp } from '@/network/devices/shells/huawei/huaweiVrrpViews';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string> }

/** La configuration VRRP identique, ecrite mot pour mot des deux cotes. */
const VRRP = [
  'vrrp vrid 1 virtual-ip 10.9.9.254',
  'vrrp vrid 1 priority 120',
  'vrrp vrid 1 preempt-mode timer delay 5',
  'vrrp vrid 1 timer advertise 3',
  'vrrp vrid 1 description SIEGE',
  'vrrp vrid 1 authentication-mode simple huawei',
  'vrrp vrid 1 track interface GigabitEthernet0/0/1 reduced 30',
];

async function routeur(): Promise<Cli> {
  const r = new HuaweiRouter(`V${++serie}`) as unknown as Cli;
  for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
    'ip address 10.9.9.1 255.255.255.0', 'undo shutdown', ...VRRP,
    'quit', 'quit']) await r.executeCommand(c);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new HuaweiSwitch('switch-huawei', `U${++serie}`, 8) as unknown as Cli;
  for (const c of ['system-view', 'vlan 9', 'quit', 'interface Vlanif 9',
    'ip address 10.9.9.1 255.255.255.0', ...VRRP,
    'quit', 'quit']) await s.executeCommand(c);
  return s;
}

const DEUX = [['routeur', routeur], ['switch', commutateur]] as const;
const lignes = (s: string) => s.split('\n');
/** Le bloc sans sa premiere ligne : celle-ci nomme l'interface, qui differe. */
const corps = (s: string) => lignes(s).slice(1);
const champ = (s: string, nom: string) =>
  lignes(s).find((l) => l.trim().startsWith(`${nom} :`))?.trim() ?? '';

describe('le `track` agit, des deux cotes', () => {
  it('une piste tombee baisse la priorite du ROUTEUR aussi', async () => {
    // GigabitEthernet0/0/1 est ferme au demarrage sur les deux
    // machines : la piste est donc DOWN et la priorite doit valoir
    // 120 - 30. Le routeur repondait 120.
    for (const [nom, fabrique] of DEUX) {
      const out = await (await fabrique()).executeCommand('display vrrp');
      expect(champ(out, 'PriorityRun'), nom).toBe('PriorityRun : 90');
      expect(champ(out, 'PriorityConfig'), nom).toBe('PriorityConfig : 120');
    }
  });

  it('la piste est nommee et son etat rendu, des deux cotes', async () => {
    for (const [nom, fabrique] of DEUX) {
      const out = await (await fabrique()).executeCommand('display vrrp');
      expect(out, nom).toContain('Track IF : GigabitEthernet0/0/1   Priority reduced : 30');
      expect(out, nom).toContain('IF state : DOWN');
    }
  });

  it('le couple PriorityRun/PriorityConfig est TOUJOURS rendu', async () => {
    // Sans piste les deux valeurs sont egales, et le commutateur ne
    // rendait alors qu'une ligne `Priority` : un lecteur ne pouvait pas
    // distinguer « pas de piste » de « piste qui n'a pas joue ».
    const r = new HuaweiRouter(`P${++serie}`) as unknown as Cli;
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.9.9.1 255.255.255.0', 'vrrp vrid 1 virtual-ip 10.9.9.254',
      'quit', 'quit']) await r.executeCommand(c);
    const out = await r.executeCommand('display vrrp');
    expect(champ(out, 'PriorityRun')).toBe('PriorityRun : 100');
    expect(champ(out, 'PriorityConfig')).toBe('PriorityConfig : 100');
  });
});

describe('une seule vue pour les deux plateformes', () => {
  it('`display vrrp` : le meme bloc, au champ pres', async () => {
    const r = await (await routeur()).executeCommand('display vrrp');
    const s = await (await commutateur()).executeCommand('display vrrp');
    expect(corps(s)).toEqual(corps(r));
  });

  it('la premiere ligne ne differe que par le nom de l\'interface', async () => {
    const r = await (await routeur()).executeCommand('display vrrp');
    const s = await (await commutateur()).executeCommand('display vrrp');
    expect(lignes(r)[0]).toBe('  GigabitEthernet0/0/0 | Virtual Router 1');
    expect(lignes(s)[0]).toBe('  Vlanif9 | Virtual Router 1');
  });

  it('`display vrrp brief` : meme en-tete et meme bloc de comptage', async () => {
    const r = await (await routeur()).executeCommand('display vrrp brief');
    const s = await (await commutateur()).executeCommand('display vrrp brief');
    expect(lignes(s)[0]).toBe(lignes(r)[0]);
    expect(lignes(s)[0]).toMatch(/^Total:1 +Master:0 +Backup:0 +Non-active:1$/);
    expect(lignes(s)[1]).toBe(lignes(r)[1]);
    expect(lignes(s)[2]).toBe(lignes(r)[2]);
  });

  it('`display vrrp statistics` est une vue A SOI, pas le bloc detaille', async () => {
    // Le greedy du commutateur avalait ses propres sous-commandes :
    // `statistics` et `verbose` y rendaient le bloc de `display vrrp`.
    for (const [nom, fabrique] of DEUX) {
      const d = await fabrique();
      const stats = await d.executeCommand('display vrrp statistics');
      expect(stats, nom).toContain('Advertisement sent : 0');
      expect(stats, nom).toContain('Track interfaces : 1');
      expect(stats, nom).not.toContain('Virtual MAC');
      expect(stats, nom).not.toBe(await d.executeCommand('display vrrp'));
    }
  });

  it('la MAC virtuelle est ecrite comme VRP l\'ecrit, et elle EXISTE des deux cotes', async () => {
    for (const [nom, fabrique] of DEUX) {
      const out = await (await fabrique()).executeCommand('display vrrp');
      expect(champ(out, 'Virtual MAC'), nom).toBe('Virtual MAC : 0000-5e00-0101');
      expect(out, nom).not.toMatch(/\b[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}\b/);
    }
  });

  it('aucune vue ne rend le nom court interne', async () => {
    for (const vue of ['display vrrp', 'display vrrp brief', 'display vrrp statistics']) {
      const out = await (await routeur()).executeCommand(vue);
      expect(out, vue).toContain('GigabitEthernet0/0/0');
      expect(out, vue).not.toMatch(/\bGE0\/0\/0\b/);
    }
  });

  it('`display vrrp interface <nom>` trouve le groupe, et resout le nom', async () => {
    // Le routeur comparait au nom court interne sans le resoudre :
    // il repondait « No VRRP group » pour l'interface qui le porte.
    for (const [nom, fabrique, ecritures] of [
      ['routeur', routeur, ['GigabitEthernet0/0/0', 'gi0/0/0', 'g 0/0/0']],
      ['switch', commutateur, ['Vlanif9', 'Vlanif 9', 'vlanif9']],
    ] as const) {
      for (const e of ecritures) {
        const out = await (await fabrique()).executeCommand(`display vrrp interface ${e}`);
        expect(out, `${nom} ${e}`).toContain('Virtual Router 1');
        expect(out, `${nom} ${e}`).toContain('PriorityRun : 90');
      }
    }
  });

  it('une interface qui n\'existe pas est refusee, des deux cotes', async () => {
    for (const [nom, fabrique] of DEUX) {
      const out = await (await fabrique()).executeCommand('display vrrp interface zzz');
      expect(out, nom).toMatch(/^Error: Wrong parameter found at '\^' position\./);
    }
  });
});

describe('une seule grammaire, et elle valide', () => {
  const REFUS = /^Error: Wrong parameter found at '\^' position\./;

  it('les bornes de VRP sont tenues des deux cotes', async () => {
    // Le routeur acceptait les cinq en silence et les rendait ensuite.
    for (const [nom, fabrique] of DEUX) {
      const d = await fabrique();
      await d.executeCommand('system-view');
      await d.executeCommand(nom === 'routeur' ? 'interface GigabitEthernet0/0/0' : 'interface Vlanif 9');
      for (const mauvais of ['vrrp vrid 999 virtual-ip 10.9.9.253', 'vrrp vrid 0 priority 100',
        'vrrp vrid 1 priority 300', 'vrrp vrid 1 priority 0',
        'vrrp vrid 1 virtual-ip pas-une-ip', 'vrrp vrid 1 timer advertise 0']) {
        expect(await d.executeCommand(mauvais), `${nom} : ${mauvais}`).toMatch(REFUS);
      }
    }
  });

  it('un mot inconnu est refuse au lieu de devenir une ligne de configuration', async () => {
    // `vrrp vrid 1 zzz` etait range dans la configuration du routeur et
    // ressortait telle quelle — donc rejoue a l'import d'une topologie.
    for (const [nom, fabrique] of DEUX) {
      const d = await fabrique();
      await d.executeCommand('system-view');
      await d.executeCommand(nom === 'routeur' ? 'interface GigabitEthernet0/0/0' : 'interface Vlanif 9');
      expect(await d.executeCommand('vrrp vrid 1 zzz'), nom).toMatch(REFUS);
      await d.executeCommand('quit');
      await d.executeCommand('quit');
      expect(await d.executeCommand('display current-configuration'), nom).not.toContain('zzz');
    }
  });

  it('le curseur designe le mot fautif, et non le premier venu', async () => {
    const a = analyserVrrp(['vrid', '1', 'priority', '300']);
    expect(a.statut).toBe('refus');
    if (a.statut === 'refus') expect(a.err).toEqual({ kind: 'wrong', token: '300' });
    const b = analyserVrrp(['vrid', '1', 'timer']);
    expect(b.statut).toBe('refus');
    if (b.statut === 'refus') expect(b.err).toEqual({ kind: 'incomplete' });
  });

  it('les formes legitimes sont acceptees', () => {
    for (const args of [['vrid', '1'], ['vrid', '255', 'priority', '254'],
      ['vrid', '1', 'preempt-mode'], ['vrid', '1', 'preempt-mode', 'timer', 'delay', '20'],
      ['vrid', '1', 'timer', 'advertise', '5'],
      ['vrid', '1', 'track', 'interface', 'GigabitEthernet0/0/1', 'reduced', '40'],
      ['vrid', '1', 'authentication-mode', 'none'],
      ['vrid', '1', 'authentication-mode', 'md5', 'cipher', 'secret'],
      ['vrid', '1', 'description', 'VERS', 'LE', 'SIEGE']]) {
      expect(analyserVrrp(args).statut, args.join(' ')).toBe('ok');
    }
  });
});

describe('ce qui est configure est rendu, et par un seul constructeur', () => {
  it('la configuration COMPLETE porte les lignes vrrp, des deux cotes', async () => {
    // Le routeur ne les rendait que dans sa vue par interface, le
    // commutateur que dans sa configuration complete : chacun perdait
    // la moitie que l'autre gardait.
    for (const [nom, fabrique] of DEUX) {
      const out = await (await fabrique()).executeCommand('display current-configuration');
      for (const l of ['vrrp vrid 1 virtual-ip 10.9.9.254', 'vrrp vrid 1 priority 120',
        'vrrp vrid 1 preempt-mode timer delay 5', 'vrrp vrid 1 timer advertise 3',
        'vrrp vrid 1 description SIEGE',
        'vrrp vrid 1 track interface GigabitEthernet0/0/1 reduced 30']) {
        expect(out, `${nom} : ${l}`).toContain(l);
      }
    }
  });

  it('la vue PAR INTERFACE rend exactement les memes lignes', async () => {
    for (const [nom, fabrique, iface] of [
      ['routeur', routeur, 'GigabitEthernet0/0/0'],
      ['switch', commutateur, 'Vlanif9'],
    ] as const) {
      const d = await fabrique();
      const seul = lignes(await d.executeCommand(`display current-configuration interface ${iface}`))
        .filter((l) => l.trim().startsWith('vrrp '));
      const tout = lignes(await d.executeCommand('display current-configuration'))
        .filter((l) => l.trim().startsWith('vrrp '));
      expect(seul.length, nom).toBeGreaterThan(0);
      expect(seul, nom).toEqual(tout);
    }
  });

  it('le bloc `interface` de la vue par interface porte le nom canonique', async () => {
    const out = await (await routeur())
      .executeCommand('display current-configuration interface GigabitEthernet0/0/0');
    expect(out).toContain('interface GigabitEthernet0/0/0');
    expect(out).not.toMatch(/\bGE0\/0\/0\b/);
  });

  it('la configuration rendue se relit : elle refait le meme groupe', async () => {
    for (const [nom, fabrique] of DEUX) {
      const source = await fabrique();
      const config = lignes(await source.executeCommand('display current-configuration'))
        .filter((l) => l.trim().startsWith('vrrp '))
        .map((l) => l.trim());
      const cible = nom === 'routeur' ? await routeur() : await commutateur();
      // La cible porte deja la meme configuration : la rejouer ne doit
      // rien changer, et surtout rien refuser.
      await cible.executeCommand('system-view');
      await cible.executeCommand(nom === 'routeur' ? 'interface GigabitEthernet0/0/0' : 'interface Vlanif 9');
      for (const l of config) {
        expect(await cible.executeCommand(l), `${nom} : ${l}`).toBe('');
      }
      await cible.executeCommand('quit');
      await cible.executeCommand('quit');
      expect(await cible.executeCommand('display vrrp'), nom)
        .toBe(await source.executeCommand('display vrrp'));
    }
  });
});

describe('ce qui n\'a pas de moteur est refuse plutot que range', () => {
  it('`admin-vrrp vrid` nomme la brique absente', async () => {
    const r = new HuaweiRouter(`A${++serie}`) as unknown as Cli;
    await r.executeCommand('system-view');
    await r.executeCommand('interface GigabitEthernet0/0/0');
    const out = await r.executeCommand('admin-vrrp vrid 1');
    expect(out).toContain('mVRRP');
    expect(out).toContain('not implemented in this simulator');
  });
});
