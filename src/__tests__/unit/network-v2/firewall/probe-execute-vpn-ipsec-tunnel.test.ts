/**
 * `execute vpn ipsec tunnel up|down` existe, et effacer UNE passerelle
 * n'efface plus toutes les AUTRES.
 *
 * Mesure de depart, sur un pare-feu portant DEUX tunnels vers deux pairs
 * distincts. (1) `execute vpn ipsec tunnel {up|down}` — la forme documentee
 * par la reference, celle qu'un operateur tape — n'existait pas :
 * « unknown action "vpn ipsec" ». Seule existait `diagnose vpn tunnel up`,
 * et il n'y avait AUCUN moyen d'abaisser un tunnel : `diagnose vpn tunnel
 * flush` et `diagnose vpn ike gateway clear` rappellent immediatement.
 * (2) Le defaut le plus couteux etait dans `clearIpsecGateway`, dont les
 * trois commandes `diagnose` dependent : il appelait `clearAllSAs()`, qui
 * vide TOUS les pairs, puis rappelait le seul tunnel NOMME. Mesure :
 * `diagnose vpn ike gateway clear name vers_b` laissait `vers_b` monte,
 * SA comprise, et faisait tomber `vers_c` — c'est-a-dire exactement
 * l'inverse de ce que la commande promet, la passerelle nommee etant la
 * seule epargnee.
 *
 * Ce que la sonde n'exige delibrement PAS : que le trafic cesse apres un
 * `down`. Un tunnel abaisse remonte au premier paquet interessant, sur un
 * vrai FortiGate comme ici, et l'exiger encoderait comme contrat un
 * blocage qu'aucune machine reelle ne fait. Un cas l'epingle dans l'autre
 * sens.
 *
 * Discrimine par `git stash push` sur les fichiers du correctif : 6 cas
 * tombent — j'en avais annonce 7, et la mesure corrige. Les 3 autres sont
 * nommes ici plutot que laisses a decouvrir. « les deux tunnels sont
 * montes au depart » est le TEMOIN du laboratoire, dont c'est l'objet de
 * passer des deux cotes. « la passerelle nommee reste montee » passe des
 * DEUX cotes pour deux raisons OPPOSEES : avant, parce qu'elle etait la
 * seule rappelee apres un effacement general ; apres, parce qu'elle est
 * la seule effacee — c'est ce qui empeche de lire la correction comme une
 * simple suppression du rappel. Et « `down` ne touche pas l'autre
 * tunnel » est VACU avant correctif : la commande n'existant pas, elle ne
 * touchait evidemment rien ; il ne garde que l'apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
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

interface Site { fw: FortiGate; sh: FortiShell }

function site(name: string, lan: string, wan: string, second?: string): Site {
  const fw = new FortiGate('firewall-fortinet', name, 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next', 'end');
  if (second !== undefined) {
    run(sh, 'config system interface',
      'edit "port3"', 'set mode static', `set ip ${second} 255.255.255.0`,
      'set allowaccess ping', 'next', 'end');
  }
  return { fw, sh };
}

function tunnel(
  s: Site, name: string, bound: string, peer: string,
  localLan: string, remoteLan: string,
): void {
  run(s.sh,
    'config vpn ipsec phase1-interface', `edit "${name}"`,
    `set interface "${bound}"`, 'set ike-version 2', `set remote-gw ${peer}`,
    'set psksecret "SecretPartage2026"', 'set proposal aes256-sha256',
    'set dhgrp 14', 'next', 'end',
    'config vpn ipsec phase2-interface', `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${localLan}.0 255.255.255.0`,
    `set dst-subnet ${remoteLan}.0 255.255.255.0`, 'next', 'end');
}

function laboratoire() {
  const a = site('FGT-A', '192.168.1', '203.0.113.1', '198.51.100.1');
  const b = site('FGT-B', '192.168.2', '203.0.113.2');
  const c = site('FGT-C', '192.168.3', '198.51.100.3');
  new Cable('ab').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);
  new Cable('ac').connect(a.fw.getPort('port3')!, c.fw.getPort('port2')!);

  tunnel(a, 'vers_b', 'port2', '203.0.113.2', '192.168.1', '192.168.2');
  tunnel(a, 'vers_c', 'port3', '198.51.100.3', '192.168.1', '192.168.3');
  tunnel(b, 'vers_a', 'port2', '203.0.113.1', '192.168.2', '192.168.1');
  tunnel(c, 'vers_a', 'port2', '198.51.100.1', '192.168.3', '192.168.1');

  a.fw.bringUpIpsecTunnel('vers_b');
  a.fw.bringUpIpsecTunnel('vers_c');
  return { a, b, c };
}

function monte(s: Site, tunnelName: string, peer: string): boolean {
  return s.fw.getTunnelTable().stateOf(tunnelName)?.status === 'up'
    && s.fw.getIpsecEngine().getIPSecSAs(peer).length > 0
    && s.fw.getIpsecEngine().hasIkeSA(peer);
}

describe('execute vpn ipsec tunnel', () => {
  it('TEMOIN : les deux tunnels sont montes au depart', () => {
    const { a } = laboratoire();

    expect(monte(a, 'vers_b', '203.0.113.2')).toBe(true);
    expect(monte(a, 'vers_c', '198.51.100.3')).toBe(true);
  });

  it('`down` par nom de phase 2 abaisse le tunnel pour de vrai', () => {
    const { a } = laboratoire();

    expect(a.sh.execute('execute vpn ipsec tunnel down vers_b-p2'))
      .not.toMatch(/unknown action|Command fail/i);
    expect(a.fw.getTunnelTable().stateOf('vers_b')?.status).toBe('down');
    expect(a.fw.getIpsecEngine().getIPSecSAs('203.0.113.2')).toHaveLength(0);
    expect(a.fw.getIpsecEngine().hasIkeSA('203.0.113.2')).toBe(false);
  });

  it('`down` ne touche pas l\'autre tunnel', () => {
    const { a } = laboratoire();
    a.sh.execute('execute vpn ipsec tunnel down vers_b-p2');

    expect(monte(a, 'vers_c', '198.51.100.3')).toBe(true);
  });

  it('`up` remonte un tunnel abaisse', () => {
    const { a } = laboratoire();
    a.sh.execute('execute vpn ipsec tunnel down vers_b-p2');

    expect(a.sh.execute('execute vpn ipsec tunnel up vers_b-p2'))
      .not.toMatch(/unknown action|Command fail/i);
    expect(monte(a, 'vers_b', '203.0.113.2')).toBe(true);
  });

  it('le nom de phase 1 designe le meme tunnel', () => {
    const { a } = laboratoire();

    a.sh.execute('execute vpn ipsec tunnel down vers_b');
    expect(a.fw.getTunnelTable().stateOf('vers_b')?.status).toBe('down');
  });

  it('le numero de serie designe le meme tunnel', () => {
    const { a } = laboratoire();
    const serie = a.fw.getTunnelTable().stateOf('vers_b')?.serial;

    a.sh.execute(`execute vpn ipsec tunnel down ${serie}`);
    expect(a.fw.getTunnelTable().stateOf('vers_b')?.status).toBe('down');
  });

  it('un nom inconnu est refuse au lieu d\'etre avale', () => {
    const { a } = laboratoire();

    expect(a.sh.execute('execute vpn ipsec tunnel down zorglub'))
      .toContain('"zorglub" does not exist.');
    expect(monte(a, 'vers_b', '203.0.113.2')).toBe(true);
  });
});

describe('diagnose vpn ike gateway clear', () => {
  it('n\'efface QUE la passerelle nommee', () => {
    const { a } = laboratoire();

    a.sh.execute('diagnose vpn ike gateway clear name vers_b');
    expect(monte(a, 'vers_c', '198.51.100.3')).toBe(true);
  });

  it('TEMOIN : la passerelle nommee reste montee, ayant ete rappelee', () => {
    const { a } = laboratoire();

    a.sh.execute('diagnose vpn ike gateway clear name vers_b');
    expect(monte(a, 'vers_b', '203.0.113.2')).toBe(true);
  });
});
