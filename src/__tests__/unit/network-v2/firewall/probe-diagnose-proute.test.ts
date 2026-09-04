/**
 * Une route de politique se VOIT, et son compteur est une mesure.
 *
 * `PolicyRouteTable` incremente `hitCount` au point exact ou une route
 * detourne un paquet, et RIEN dans toute la CLI FortiOS ne lisait ce
 * compteur : moteur sans porte, la forme que ce depot referme
 * regulierement. Le manque n'etait pas cosmetique — une route de
 * politique est INVISIBLE dans `get router info routing-table`, qui ne
 * montre que la table unicast, donc `diagnose firewall proute list` est
 * la SEULE vue ou elle existe ; sans elle, un operateur dont le trafic
 * part par la mauvaise interface n'a aucun moyen de voir la regle qui
 * le detourne, ni de savoir si elle a jamais servi.
 *
 * La mise en forme vient de transcriptions reelles (`list route policy
 * info(vf=root):`, `id=1(0x01) ... iif=5(port3) dport=0-65535
 * oif=3(port1) gwy=192.0.1.254`, `source(1): ...`, `destination(1):
 * ...`, `hit_count=0 last_used=2023-08-26 10:06:57`) et non de la
 * reference 6.0.4, qui documente `execute` et PAS `diagnose`.
 *
 * **Trois decisions, chacune parce que l'inverse etait possible.**
 *
 *   1. **Les champs sans magasin ne sont pas rendus.** Une vraie sortie
 *      porte aussi `dscp_tag=`, `tos=`, `tos_mask=`, `flags=` et
 *      `vwl_service=` ; le schema `config router policy` de ce
 *      simulateur ne porte aucun de ces attributs, donc les ecrire
 *      serait afficher une constante que rien ne soutient — le defaut
 *      meme qu'on referme ici.
 *   2. **`last_used` n'est rendu qu'apres un vrai passage.** Il n'existe
 *      aucune transcription attestee d'une route JAMAIS utilisee, donc
 *      ce point est un choix et il est dit : dater une route que rien
 *      n'a empruntee annoncerait un usage qui n'a pas eu lieu.
 *   3. **Les bornes se DERIVENT du prefixe.** `source(1)` est une plage
 *      premiere-derniere calculee du couple reseau/masque, jamais une
 *      recopie du prefixe configure.
 *
 * `diagnose firewall proute clear [id]` est atteste et arrive avec la
 * vue : un compteur qu'on peut lire et pas remettre a zero se relit
 * faux au laboratoire suivant. Il vide le compteur ET la date, un
 * `last_used` survivant a la remise a zero decrivant un usage que le
 * compteur ne compte plus.
 *
 * Discrimine par `git stash push -- src/network/` : 11 des 12 cas
 * tombent. Le seul restant est nomme ici plutot que laisse a
 * decouvrir, et il ne prouve pas la vue : « le laboratoire detourne
 * vraiment le trafic » est le TEMOIN, et c'est son objet de passer des
 * deux cotes puisqu'il lit le magasin directement — sans lui, un
 * `hit_count=1` pourrait venir d'un laboratoire qui ne route rien.
 *
 * Un second cas etait annonce comme non discriminant et la mesure a dit
 * le contraire : « un paquet qui ne correspond pas ne compte pas » lit
 * le magasin, mais il verifie aussi que la VUE porte `hit_count=0`, et
 * avant correctif il n'y a pas de vue du tout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
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

function laboratoire(): { fw: FortiGate; sh: FortiShell } {
  const fw = new FortiGate('firewall-fortinet', 'FGT1', 0, 0);
  const sh = new FortiShell(fw);

  run(sh,
    'config system global', 'set timezone "UTC"', 'end',
    'config system interface',
    'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'edit "port3"', 'set mode static', 'set ip 198.51.100.1 255.255.255.0', 'next',
    'end',
    'config router static', 'edit 1',
    'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.254', 'set device "port2"',
    'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2" "port3"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');

  return { fw, sh };
}

function detournement(sh: FortiShell): void {
  run(sh, 'config router policy', 'edit 1',
    'set input-device "port1"',
    'set src "192.168.1.0/24"',
    'set output-device "port3"',
    'set gateway 198.51.100.254',
    'next', 'end');
}

function refus(sh: FortiShell): void {
  run(sh, 'config router policy', 'edit 2',
    'set input-device "port2"',
    'set dst "10.0.0.0/8"',
    'set protocol 6', 'set start-port 80', 'set end-port 443',
    'set action deny', 'next', 'end');
}

function trafic(fw: FortiGate): string | undefined {
  return fw.simulate({
    ingressPort: 'port1', protocol: 'tcp',
    sourceIP: '192.168.1.10', destinationIP: '8.8.8.8',
    sourcePort: 40000, destinationPort: 443,
  }).egressPort;
}

describe('diagnose firewall proute list', () => {
  it('sans route de politique, la vue est un en-tete et rien de plus', () => {
    const { sh } = laboratoire();

    expect(sh.execute('diagnose firewall proute list'))
      .toBe('list route policy info(vf=root):');
  });

  it('nomme le domaine virtuel dont la table est lue', () => {
    const { sh } = laboratoire();

    expect(sh.execute('diagnose firewall proute list')).toContain('(vf=root)');
  });

  it('rend la route configuree avec ses interfaces et sa passerelle', () => {
    const { sh } = laboratoire();
    detournement(sh);

    const vue = sh.execute('diagnose firewall proute list');
    expect(vue).toContain('id=1(0x01)');
    expect(vue).toContain('iif=1(port1)');
    expect(vue).toContain('oif=3(port3)');
    expect(vue).toContain('gwy=198.51.100.254');
  });

  it('derive les bornes du prefixe au lieu de le recopier', () => {
    const { sh } = laboratoire();
    detournement(sh);

    const vue = sh.execute('diagnose firewall proute list');
    expect(vue).toContain('source(1): 192.168.1.0-192.168.1.255');
    expect(vue).toContain('destination(1): 0.0.0.0-255.255.255.255');
  });

  it('le laboratoire detourne vraiment le trafic', () => {
    const { fw, sh } = laboratoire();
    detournement(sh);

    expect(trafic(fw)).toBe('port3');
    expect(fw.getPolicyRoutes().ordered()[0].hitCount).toBe(1);
  });

  it('hit_count compte un paquet reel, et last_used le date', () => {
    const { fw, sh } = laboratoire();
    detournement(sh);

    expect(sh.execute('diagnose firewall proute list')).toContain('\nhit_count=0');

    trafic(fw);

    const apres = sh.execute('diagnose firewall proute list');
    expect(apres).toMatch(/hit_count=1 last_used=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('un paquet qui ne correspond pas ne compte pas', () => {
    const { fw, sh } = laboratoire();
    detournement(sh);

    fw.simulate({
      ingressPort: 'port2', protocol: 'tcp',
      sourceIP: '203.0.113.9', destinationIP: '8.8.8.8',
      sourcePort: 40000, destinationPort: 443,
    });

    expect(fw.getPolicyRoutes().ordered()[0].hitCount).toBe(0);
    expect(sh.execute('diagnose firewall proute list')).toContain('\nhit_count=0');
  });

  it('une route de refus rend action=deny sans sortie ni passerelle', () => {
    const { sh } = laboratoire();
    refus(sh);

    const ligne = sh.execute('diagnose firewall proute list')
      .split('\n').find(l => l.startsWith('id=2')) ?? '';
    expect(ligne).toContain('action=deny');
    expect(ligne).toContain('protocol=6');
    expect(ligne).toContain('dport=80-443');
    expect(ligne).not.toContain('oif=');
    expect(ligne).not.toContain('gwy=');
  });

  it('les routes sont rendues dans l ordre de la table', () => {
    const { sh } = laboratoire();
    detournement(sh);
    refus(sh);

    const vue = sh.execute('diagnose firewall proute list');
    expect(vue.indexOf('id=1(0x01)')).toBeLessThan(vue.indexOf('id=2(0x02)'));
  });

  it('clear <id> ne remet a zero que la route nommee', () => {
    const { fw, sh } = laboratoire();
    detournement(sh);
    refus(sh);

    trafic(fw);
    fw.simulate({
      ingressPort: 'port2', protocol: 'tcp',
      sourceIP: '203.0.113.9', destinationIP: '10.1.2.3',
      sourcePort: 40000, destinationPort: 80,
    });
    expect(fw.getPolicyRoutes().ordered().map(r => r.hitCount)).toEqual([1, 1]);

    sh.execute('diagnose firewall proute clear 1');

    const vue = sh.execute('diagnose firewall proute list');
    expect(vue).toContain('\nhit_count=0\n');
    expect(vue).toMatch(/hit_count=1 last_used=/);
    expect(fw.getPolicyRoutes().ordered().map(r => r.hitCount)).toEqual([0, 1]);
  });

  it('clear sans identifiant vide tous les compteurs et leur date', () => {
    const { fw, sh } = laboratoire();
    detournement(sh);
    refus(sh);
    trafic(fw);

    sh.execute('diagnose firewall proute clear');

    const vue = sh.execute('diagnose firewall proute list');
    expect(vue).not.toContain('last_used=');
    expect(fw.getPolicyRoutes().ordered().map(r => r.hitCount)).toEqual([0, 0]);
  });

  it('l aide annonce la famille et ses deux commandes', () => {
    const { sh } = laboratoire();

    expect(sh.execute('diagnose firewall ?')).toContain('proute');
    const aide = sh.execute('diagnose firewall proute ?');
    expect(aide).toContain('list');
    expect(aide).toContain('clear');
    expect(sh.execute('diagnose firewall proute zorglub'))
      .toContain('unknown command');
  });
});
