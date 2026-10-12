/*
 * `diagnose debug application ike -1` : la trace du demon IKE d'un FortiGate.
 *
 * Les lignes ne sont pas inventees : chacune est la traduction d'un
 * evenement que le moteur IPsec publie deja sur le bus de la machine
 * (ipsec.ike.sa-installed, ipsec.sa.installed, ipsec.dpd.*, *.deleted),
 * prefixee `ike 0:<tunnel>:` comme le fait FortiOS, le nom du tunnel etant
 * retrouve par l'adresse du pair dans la table des phases 1. Le texte apres
 * le prefixe n'est PAS attesté par une capture FortiOS (les lignes reelles
 * portent des cookies et des charges utiles que ce moteur ne materialise
 * pas) ; seul le prefixe et la nature des evenements sont reels.
 *
 * Avant le correctif `ike` n'etait pas un demon connu : 3 des 5 cas
 * tombent (git stash de src/network). Passent des deux cotes le TEMOIN
 * « sans diagnose debug enable, rien n est trace », qui prouve que le
 * laboratoire monte bien un tunnel sans que la trace s'en mele, et
 * « niveau 0 arrete la trace », vide des deux cotes (la commande etait
 * refusee avant, ignoree apres) : il ne vaut que contre le cas positif
 * du meme laboratoire.
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

function site(name: string, lan: string, wan: string, at: number) {
  const fw = new FortiGate('firewall-fortinet', name, at, 0);
  const sh = new FortiShell(fw);
  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end');
  return { fw, sh };
}

function tunnel(sh: FortiShell, name: string, peer: string, local: string, remote: string): void {
  run(sh, 'config vpn ipsec phase1-interface', `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2', `set remote-gw ${peer}`,
    `set psksecret "${PSK}"`, 'set proposal aes256-sha256', 'set dhgrp 14', 'next', 'end');
  run(sh, 'config vpn ipsec phase2-interface', `edit "${name}-p2"`, `set phase1name "${name}"`,
    `set src-subnet ${local}.0 255.255.255.0`, `set dst-subnet ${remote}.0 255.255.255.0`, 'next', 'end');
}

function pair() {
  const a = site('FGT-A', '192.168.1', '203.0.113.1', -200);
  const b = site('FGT-B', '192.168.2', '203.0.113.2', 200);
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);
  tunnel(a.sh, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2');
  tunnel(b.sh, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1');
  return { a, b };
}

const trace = (fw: FortiGate): string => fw.getDhcpDebug().lines().join('\n');
const START = ['diagnose debug reset', 'diagnose debug application ike -1', 'diagnose debug enable'];

describe('diagnose debug application ike', () => {
  it('WITNESS : sans diagnose debug enable, le tunnel monte et rien n est trace', () => {
    const { a } = pair();
    run(a.sh, 'diagnose debug application ike -1', 'diagnose vpn tunnel up vers_b');
    expect(a.fw.getTunnelTable().stateOf('vers_b')?.gatewayUp).toBe(true);
    expect(trace(a.fw)).toBe('');
  });

  it('le demon ike est accepte', () => {
    const { a } = pair();
    expect(run(a.sh, 'diagnose debug application ike -1')).toBe('');
  });

  it('la montee du tunnel est tracee avec le nom du tunnel', () => {
    const { a } = pair();
    run(a.sh, ...START, 'diagnose vpn tunnel up vers_b');
    expect(trace(a.fw)).toMatch(/ike 0:vers_b: established IKEv[12] SA 203\.0\.113\.1->203\.0\.113\.2/);
    expect(trace(a.fw)).toMatch(/ike 0:vers_b: add IPsec SA: SPIs\(in [0-9a-f]{8} out [0-9a-f]{8}\), esp/);
  });

  it('niveau 0 arrete la trace', () => {
    const { a } = pair();
    run(a.sh, ...START, 'diagnose debug application ike 0', 'diagnose vpn tunnel up vers_b');
    expect(trace(a.fw)).toBe('');
  });

  it('l effacement des SA est trace', () => {
    const { a } = pair();
    run(a.sh, 'diagnose vpn tunnel up vers_b');
    run(a.sh, ...START, 'diagnose vpn ike gateway clear name vers_b');
    expect(trace(a.fw)).toMatch(/ike 0:vers_b: (IKE SA deleted|delete IPsec SA)/);
  });
});
