/**
 * `get vpn ipsec stats tunnel` compte ce que la table porte deja.
 *
 * La table des tunnels tient tout ce que la vue attestee demande —
 * `Phase1Type` distingue DEJA `static`, `dynamic` et `ddns`, chaque
 * phase 2 est rattachee a sa phase 1 par `selectorsOf`, et l'etat de
 * chaque tunnel porte son verdict d'echec — et rien ne comptait ces
 * lignes. La reference 6.0.4 donne la sortie mot pour mot, deux blocs
 * de quatre et deux chiffres : `tunnels` / `total` / `static/ddns` /
 * `dynamic` / `manual` / `errors`, puis `selectors` / `total` / `up`.
 *
 * **Chaque chiffre est LU, et les deux qui ne pouvaient pas l'etre sont
 * dits.** `manual` reste a zero parce que `config vpn ipsec manualkey`
 * n'existe pas dans ce simulateur : aucun tunnel a cle manuelle ne peut
 * exister, donc zero est la verite et non un remplissage. `errors`
 * compte les tunnels dont le moteur a NOTE un echec — le champ
 * `failure` que `bringUpTunnel` ecrit — et c'est son second lecteur, le
 * premier etant le message de `diagnose vpn tunnel up`.
 *
 * `selectors up` est DERIVE de l'etat de la phase 1, exactement comme
 * le fait deja `diagnose vpn tunnel list` en ecrivant `sa=1` sous chaque
 * proxyid : cette table ne tient pas d'etat par selecteur, et en
 * inventer un ferait que les deux vues repondraient deux choses
 * differentes du meme tunnel.
 *
 * `get vpn ipsec stats crypto` n'est deliberement PAS ecrite : sa
 * sortie compte les octets chiffres et dechiffres par algorithme, et ce
 * simulateur ne tient aucun compteur par algorithme — la rendre
 * reviendrait a afficher huit zeros qui ne mesurent rien.
 *
 * Discrimine par `git stash push -- src/network/` : 5 des 7 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le tunnel monte pour de bon » est le TEMOIN, et c'est son objet
 *     de passer des deux cotes : sans lui, un `up: 0` et un tunnel qui
 *     ne monte pas seraient indiscernables ;
 *   - « un tunnel de secours declare est bien de type dynamique » lit la
 *     table et non la vue, donc il dit que la distinction existait deja
 *     — ce que la vue ne fait que rendre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const PSK = 'SecretPartage2026';

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

function site(name: string, lan: string, wan: string, at: number): Site {
  const fw = new FortiGate('firewall-fortinet', name, at, 0);
  const sh = new FortiShell(fw);
  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`, 'next', 'end');
  return { fw, sh };
}

function tunnel(
  s: Site, name: string, peer: string, local: string, remote: string,
): void {
  run(s.sh, 'config vpn ipsec phase1-interface', `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2', `set remote-gw ${peer}`,
    `set psksecret "${PSK}"`, 'set proposal aes256-sha256', 'set dhgrp 14',
    'next', 'end',
    'config vpn ipsec phase2-interface', `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${local}.0 255.255.255.0`,
    `set dst-subnet ${remote}.0 255.255.255.0`, 'next', 'end');
}

function paire() {
  const a = site('FGT-A', '192.168.1', '203.0.113.1', -200);
  const b = site('FGT-B', '192.168.2', '203.0.113.2', 200);
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);

  tunnel(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2');
  tunnel(b, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1');
  return { a, b };
}

function champs(vue: string): Record<string, string> {
  const out: Record<string, string> = {};
  let bloc = '';
  for (const ligne of vue.split('\n')) {
    const [nom, valeur] = ligne.split(': ');
    if (valeur === undefined) { bloc = ligne; continue; }
    out[`${bloc}.${nom}`] = valeur;
  }
  return out;
}

describe('get vpn ipsec stats tunnel', () => {
  it('sans tunnel, les deux blocs sont a zero', () => {
    const { sh } = site('FGT', '192.168.1', '203.0.113.1', 0);

    expect(sh.execute('get vpn ipsec stats tunnel')).toBe(
      'tunnels\ntotal: 0\nstatic/ddns: 0\ndynamic: 0\nmanual: 0\nerrors: 0\n'
      + 'selectors\ntotal: 0\nup: 0');
  });

  it('compte le tunnel et son selecteur des leur declaration', () => {
    const { a } = paire();

    expect(champs(a.sh.execute('get vpn ipsec stats tunnel'))).toMatchObject({
      'tunnels.total': '1', 'tunnels.static/ddns': '1',
      'tunnels.dynamic': '0', 'selectors.up': '0',
    });
  });

  it('le tunnel monte pour de bon', () => {
    const { a } = paire();

    expect(a.sh.execute('diagnose vpn tunnel up vers_b')).toBe('');
    expect(a.fw.getTunnelTable().stateOf('vers_b')?.status).toBe('up');
  });

  it('un selecteur passe a `up` quand le tunnel monte', () => {
    const { a } = paire();
    a.sh.execute('diagnose vpn tunnel up vers_b');

    expect(champs(a.sh.execute('get vpn ipsec stats tunnel'))['selectors.up'])
      .toBe('1');
  });

  it('un tunnel de secours declare est bien de type dynamique', () => {
    const { a } = paire();
    run(a.sh, 'config vpn ipsec phase1-interface', 'edit "dialup"',
      'set interface "port2"', 'set type dynamic', 'set ike-version 2',
      `set psksecret "${PSK}"`, 'next', 'end');

    expect(a.fw.getTunnelTable().getPhase1('dialup')?.type).toBe('dynamic');
  });

  it('un tunnel dynamique se compte a part des tunnels fixes', () => {
    const { a } = paire();
    run(a.sh, 'config vpn ipsec phase1-interface', 'edit "dialup"',
      'set interface "port2"', 'set type dynamic', 'set ike-version 2',
      `set psksecret "${PSK}"`, 'next', 'end');

    expect(champs(a.sh.execute('get vpn ipsec stats tunnel'))).toMatchObject({
      'tunnels.total': '2', 'tunnels.static/ddns': '1', 'tunnels.dynamic': '1',
    });
  });

  it('un tunnel qui a echoue est compte en erreur', () => {
    const { a } = paire();
    run(a.sh, 'config vpn ipsec phase1-interface', 'edit "dialup"',
      'set interface "port2"', 'set type dynamic', 'set ike-version 2',
      `set psksecret "${PSK}"`, 'next', 'end');

    expect(champs(a.sh.execute('get vpn ipsec stats tunnel'))['tunnels.errors'])
      .toBe('0');

    a.sh.execute('diagnose vpn tunnel up dialup');

    expect(champs(a.sh.execute('get vpn ipsec stats tunnel'))['tunnels.errors'])
      .toBe('1');
  });
});
