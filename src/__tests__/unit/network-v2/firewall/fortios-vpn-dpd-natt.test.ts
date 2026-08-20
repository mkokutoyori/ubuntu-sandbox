/**
 * `dpd` et `nattraversal` agissent, et `diagnose` rapporte une mesure.
 *
 * Les deux etaient acceptes, ranges, rendus par `show` et par `diagnose
 * vpn tunnel list` — et le moteur ne les recevait pas. Pire pour le
 * second : la vue annoncait `natt: mode=silent` parce que la
 * CONFIGURATION dit `enable`, alors que ce champ decrit ce que la
 * session a NEGOCIE. Sur un chemin sans traduction d'adresses, un vrai
 * FortiGate ecrit `natt: mode=none` quoi qu'on ait configure : NAT-T ne
 * s'emploie que lorsqu'une traduction est detectee.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **`dpd disable` ne sonde pas**, `on-idle` sonde periodiquement,
 *      `on-demand` ne sonde que s'il y a du trafic a proteger.
 *   2. **`dpd-retrycount` decide quand le tunnel tombe** : c'est la
 *      seule chose que la detection de pair mort promet.
 *   3. **La sonde est un vrai datagramme** sur le fil, pas un compteur.
 *   4. **`nattraversal` gouverne l'emploi de NAT-T**, et la vue rapporte
 *      ce que la session a retenu.
 *
 * Defaut trouve en la mesurant : `diagnose vpn tunnel up` REPROGRAMMAIT
 * le moteur et ne NEGOCIAIT rien — la commande dont le nom est « monte
 * ce tunnel » se contentait de constater qu'aucune association n'existait.
 *
 * Discriminee par `git stash push -- src/network/` : 7 des 11 cas
 * tombent avant correctif. Les 4 restants sont nommes ici : « `disable`
 * n'arme rien » passait parce que RIEN n'etait arme dans aucun cas,
 * « un pair muet fait tomber le tunnel » parce qu'aucune association
 * n'existait pour tomber, « `set dpd` refuse un mot inconnu » parce que
 * l'enumeration etait deja declaree, et « la configuration rendue
 * reproduit ce qui a ete tape » parce que le rendu, lui, etait correct
 * depuis toujours — c'est justement ce qui rendait le decor credible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Site {
  fw: FortiGate;
  sh: FortiShell;
}

function site(name: string, lan: string, wan: string): Site {
  const fw = new FortiGate('firewall-fortinet', name, 0, 0);
  const sh = new FortiShell(fw);
  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next', 'end');
  return { fw, sh };
}

function tunnel(
  s: Site, name: string, peer: string, localLan: string, remoteLan: string,
  extra: readonly string[] = [],
): void {
  run(s.sh,
    'config vpn ipsec phase1-interface',
    `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2',
    `set remote-gw ${peer}`, 'set psksecret "SecretPartage2026"',
    'set proposal aes256-sha256', 'set dhgrp 14',
    ...extra,
    'next', 'end',
    'config vpn ipsec phase2-interface',
    `edit "${name}-p2"`, `set phase1name "${name}"`,
    `set src-subnet ${localLan}.0 255.255.255.0`,
    `set dst-subnet ${remoteLan}.0 255.255.255.0`,
    'next', 'end');
}

function laboratoire(reglages: readonly string[] = []) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const a = site('FGT-A', '192.168.1', '203.0.113.1');
  const b = site('FGT-B', '192.168.2', '203.0.113.2');
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);

  tunnel(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2', reglages);
  tunnel(b, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1');

  a.fw.bringUpIpsecTunnel('vers_b');
  return { a, b };
}

interface DpdEngine {
  getDPDConfig(): { interval: number; retries: number; mode: string } | null;
  runDPDCheck(): string[];
}

function moteur(s: Site): DpdEngine {
  return s.fw.getIpsecEngine() as unknown as DpdEngine;
}

function vieillirSondes(s: Site): void {
  const engine = s.fw.getIpsecEngine() as unknown as {
    ikeSADB: Map<string, { lastDPDActivity?: number }>;
  };
  for (const [, sa] of engine.ikeSADB) sa.lastDPDActivity = Date.now() - 600_000;
}

beforeEach(() => { Logger.reset(); });

describe('set dpd', () => {
  it('`on-idle` arme une detection periodique dans le moteur', () => {
    const { a } = laboratoire(['set dpd on-idle']);

    expect(moteur(a).getDPDConfig()?.mode).toBe('periodic');
  });

  it('`disable` n`arme rien du tout', () => {
    const { a } = laboratoire(['set dpd disable']);

    expect(moteur(a).getDPDConfig()).toBeNull();
  });

  it('l`intervalle et le nombre d`essais viennent de la configuration', () => {
    const { a } = laboratoire([
      'set dpd on-idle', 'set dpd-retryinterval 25', 'set dpd-retrycount 5',
    ]);

    expect(moteur(a).getDPDConfig()).toMatchObject({ interval: 25, retries: 5 });
  });

  it('les valeurs par defaut sont celles de FortiOS', () => {
    const { a } = laboratoire(['set dpd on-idle']);

    expect(moteur(a).getDPDConfig()).toMatchObject({ interval: 15, retries: 3 });
  });

  it('la sonde est un vrai datagramme, et le pair vivant repond', () => {
    const { a } = laboratoire(['set dpd on-idle', 'set dpd-retryinterval 1']);
    const avant = a.fw.getPacketCapture().count();
    vieillirSondes(a);

    moteur(a).runDPDCheck();

    expect(a.fw.getPacketCapture().count()).toBeGreaterThan(avant);
    expect(a.sh.execute('diagnose vpn tunnel summary')).toMatch(/up/);
  });

  it('un pair muet fait tomber le tunnel apres `dpd-retrycount` essais', () => {
    const { a, b } = laboratoire(['set dpd on-idle', 'set dpd-retrycount 2']);
    b.fw.getPort('port2')!.setAdminDown(true);

    for (let essai = 0; essai < 4; essai++) {
      vieillirSondes(a);
      moteur(a).runDPDCheck();
    }

    expect(a.fw.getIpsecEngine().getIPSecSAs('203.0.113.2')).toHaveLength(0);
  });

  it('`set dpd` refuse un mot inconnu', () => {
    const { a } = laboratoire();

    expect(run(a.sh,
      'config vpn ipsec phase1-interface', 'edit "vers_b"', 'set dpd parfois'))
      .toMatch(/[Ii]nvalid|Command fail/);
    run(a.sh, 'abort');
  });
});

describe('set nattraversal', () => {
  it('sans traduction sur le chemin, la vue annonce `mode=none`', () => {
    const { a } = laboratoire();

    expect(a.sh.execute('diagnose vpn tunnel list')).toMatch(/natt: mode=none/);
  });

  it('`forced` emploie NAT-T meme sans traduction detectee', () => {
    const { a } = laboratoire(['set nattraversal forced']);

    expect(a.sh.execute('diagnose vpn tunnel list')).toMatch(/natt: mode=silent/);
    expect(a.fw.getIpsecEngine().getIPSecSAs('203.0.113.2')[0]?.natT).toBe(true);
  });

  it('`disable` interdit NAT-T', () => {
    const { a } = laboratoire(['set nattraversal disable']);

    expect(a.fw.getIpsecEngine().getIPSecSAs('203.0.113.2')[0]?.natT).toBe(false);
    expect(a.sh.execute('diagnose vpn tunnel list')).toMatch(/natt: mode=none/);
  });

  it('la configuration rendue reproduit ce qui a ete tape', () => {
    const { a } = laboratoire(['set dpd on-idle', 'set nattraversal forced']);

    const rendu = a.sh.execute('show vpn ipsec phase1-interface');
    expect(rendu).toMatch(/set dpd on-idle/);
    expect(rendu).toMatch(/set nattraversal forced/);
  });
});
