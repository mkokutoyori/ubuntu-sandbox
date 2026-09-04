/**
 * Les services et adresses predefinis sont des entrees ORDINAIRES de
 * leur table, et `show` n'en montrait aucune.
 *
 * Mesure de depart sur un pare-feu sorti d'usine : `show firewall
 * service custom` rend `config firewall service custom` / `end`, deux
 * lignes et rien entre les deux ; `get firewall service custom` rend la
 * chaine vide ; `get firewall service custom HTTP` repond « "HTTP" does
 * not exist » — pendant que `set service "HTTP"` sur une politique
 * fonctionne parfaitement. Autrement dit, l'operateur ne pouvait ni
 * decouvrir quels services existent, ni voir ce que `ALL_TCP` recouvre,
 * alors que le moteur, lui, les connaissait tous. Meme chose pour `all`
 * et `all6`.
 *
 * **La cause etait deux magasins pour un fait.** `PREDEFINED_SERVICES`
 * et `PREDEFINED_ADDRESSES` etaient verses dans l'`ObjectStore` — le
 * moteur de correspondance — et jamais dans l'ARBRE DE CONFIGURATION,
 * qui est la seule chose que `show` et `get` lisent. Sur une vraie
 * machine ce ne sont pas des valeurs par defaut cachees : ce sont des
 * entrees ordinaires de `config firewall service custom`, editables
 * comme les autres, et `show` les liste. Elles sont desormais semees
 * dans l'arbre DEPUIS LA MEME declaration, donc une seule ecriture et
 * deux projections ; `spec.predefined`, qui les protege deja de
 * `factoryreset`, gagne son second lecteur.
 *
 * **Le semis se fait apres avoir lie la portee**, et c'est la mesure
 * qui l'a impose : l'arbre indexe ses tables par domaine virtuel, donc
 * semer avant que la portee soit liee rangeait tout sous une portee
 * vide et le shell, qui lie la sienne ensuite, ne voyait rien.
 *
 * **DEUX defauts trouves en chemin, tous deux revelés parce que les
 * tables ont enfin plus d'une entree.**
 *
 *   1. `show` DEPUIS un objet rendait la table ENTIERE. Le rendu
 *      recevait le chemin de l'objet et pas sa cle, ce qui ne se voyait
 *      pas tant qu'une table de test n'avait qu'une entree : depuis
 *      `edit HTTP`, `show` deroulait les trente-six services. La cle
 *      n'est passee que pour un objet de TABLE — un objet SINGLETON
 *      (`config system console`) n'en a pas, et la lui passer rendait
 *      la chaine vide ; c'est un cas existant qui l'a attrape.
 *   2. `set protocol ICMP` sans `icmptype` donnait le type 0, c'est-a-dire
 *      la reponse d'echo, au lieu de « tout ICMP ». Le gestionnaire
 *      lisait `effective`, qui substitue le defaut declare par le
 *      schema, la ou il faut savoir si l'operateur a POSE la valeur.
 *      Le service predefini `ALL_ICMP` etait construit sans type et le
 *      meme service ecrit a la main en recevait un : deux comportements
 *      pour une meme commande.
 *
 * `show full <chemin>` est ajoutee parce que la reference 6.0.4 s'en
 * sert elle-meme (`show full system global | grep rad`) et qu'elle
 * etait refusee ; seules les deux orthographes attestees sont
 * acceptees, un prefixe plus court n'etant atteste nulle part et
 * risquant de confondre `full` avec `firewall`.
 *
 * Discrimine par `git stash push -- src/network/` : 7 des 12 cas
 * tombent. J'en annoncais 10 ; les 5 qui passent des deux cotes sont
 * nommes ici avec la raison de chacun plutot que laisses a decouvrir :
 *
 *   - « le moteur connaissait deja ces services » est le TEMOIN, et
 *     c'est son objet : il dit que le fait existait avant la vue, donc
 *     que rien n'a ete invente ;
 *   - « une politique nomme un service predefini » garde que le semis
 *     n'a pas change ce que le moteur fait correspondre ;
 *   - « rend cet objet et non toute la table » est VACUE avant
 *     correctif — la table ne contenait que le `HTTP` que le cas venait
 *     de creer, donc « ne contient pas ALL_TCP » etait vrai sans rien
 *     prouver ; il ne discrimine qu'accompagne du semis, et c'est
 *     precisement pourquoi le defaut avait pu passer inapercu ;
 *   - « un objet unique rend toujours ses reglages » et « un type pose
 *     explicitement est retenu » sont les deux gardes des erreurs
 *     commises en chemin, donc passent des deux cotes par construction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  return { fw, sh: fw.getShell() as FortiShell };
}

describe('les objets predefinis sont des entrees de leur table', () => {
  it('le moteur connaissait deja ces services', () => {
    const { fw } = laboratoire();

    for (const name of ['ALL', 'ALL_TCP', 'ALL_ICMP', 'HTTP']) {
      expect(fw.getObjectStore().getService(name)).toBeDefined();
    }
  });

  it('`show firewall service custom` les liste', () => {
    const { sh } = laboratoire();

    const vue = sh.execute('show firewall service custom');
    expect(vue).toContain('edit "HTTP"');
    expect(vue).toContain('set tcp-portrange 80');
    expect(vue).toContain('edit "ALL_ICMP"');
    expect(vue).toContain('set protocol ICMP');
  });

  it('un service a plusieurs protocoles rend ses deux plages', () => {
    const { sh } = laboratoire();

    const vue = sh.execute('show firewall service custom').split('\n');
    const debut = vue.findIndex(l => l.includes('edit "DNS"'));
    expect(vue.slice(debut, debut + 3).join('\n'))
      .toContain('set tcp-portrange 53');
    expect(vue.slice(debut, debut + 3).join('\n'))
      .toContain('set udp-portrange 53');
  });

  it('`get firewall service custom` enumere les entrees', () => {
    const { sh } = laboratoire();

    const vue = sh.execute('get firewall service custom');
    expect(vue).toContain('== [ ALL ]');
    expect(vue).toContain('name: ALL');
    expect(vue).toContain('== [ HTTP ]');
  });

  it('`get firewall service custom HTTP` decrit le service', () => {
    const { sh } = laboratoire();

    const vue = sh.execute('get firewall service custom HTTP');
    expect(vue).toContain('name                : "HTTP"');
    expect(vue).toContain('tcp-portrange       : 80');
  });

  it('`all` et `all6` sont chacun dans leur table', () => {
    const { sh } = laboratoire();

    expect(sh.execute('show firewall address')).toContain('edit "all"');
    expect(sh.execute('show firewall address')).toContain('set subnet 0.0.0.0 0.0.0.0');
    expect(sh.execute('show firewall address6')).toContain('edit "all6"');
    expect(sh.execute('show firewall address6')).toContain('set ip6 ::/0');
  });

  it('une politique nomme un service predefini', () => {
    const { sh } = laboratoire();
    run(sh, 'config system interface',
      'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next', 'end');

    const sortie = run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set service "HTTP"', 'set action accept', 'set schedule "always"',
      'next', 'end');
    expect(sortie).not.toMatch(/Command fail|does not exist/);
  });
});

describe('show depuis un objet', () => {
  it('rend cet objet et non toute la table', () => {
    const { sh } = laboratoire();
    run(sh, 'config firewall service custom', 'edit HTTP');

    const vue = sh.execute('show');
    sh.execute('abort');

    expect(vue).toContain('edit "HTTP"');
    expect(vue).not.toContain('edit "ALL_TCP"');
  });

  it('un objet unique rend toujours ses reglages', () => {
    const { sh } = laboratoire();
    run(sh, 'config system console', 'set output standard');

    const vue = sh.execute('show');
    sh.execute('end');

    expect(vue).toContain('set output standard');
  });
});

describe('protocol ICMP sans type', () => {
  it('correspond a tout ICMP, comme le service predefini', () => {
    const { fw, sh } = laboratoire();
    run(sh, 'config firewall service custom', 'edit "MONICMP"',
      'set protocol ICMP', 'next', 'end');

    expect(fw.getObjectStore().getService('MONICMP')?.entries)
      .toEqual(fw.getObjectStore().getService('ALL_ICMP')?.entries);
  });

  it('un type pose explicitement est retenu', () => {
    const { fw, sh } = laboratoire();
    run(sh, 'config firewall service custom', 'edit "MONECHO"',
      'set protocol ICMP', 'set icmptype 8', 'next', 'end');

    expect(fw.getObjectStore().getService('MONECHO')?.entries)
      .toEqual([{ protocol: 'icmp', icmpType: 8 }]);
  });
});

describe('show full', () => {
  it('la forme abregee de la reference est acceptee', () => {
    const { sh } = laboratoire();

    const vue = sh.execute('show full system global');
    expect(vue).not.toMatch(/unknown configuration path/);
    expect(vue).toContain('config system global');
    expect(vue).toBe(sh.execute('show full-configuration system global'));
  });
});
