/**
 * `diagnose vpn tunnel up` disait la meme chose de cinq situations.
 *
 * Mesure de depart, une commande et quatre laboratoires : le nom
 * OUBLIE, un nom qui n'existe PAS, un tunnel declare sans selecteur de
 * phase 2, un tunnel complet dont le pair ne repond pas, et un tunnel
 * dont la phase 1 monte mais dont les selecteurs ne concordent pas —
 * tous les cinq repondaient mot pour mot ``tunnel `X` did not come
 * up.``. Quatre de ces cinq envoient l'operateur regarder IKE, alors
 * que dans trois cas il n'y a rien a y voir.
 *
 * **La raison EXISTAIT deja et etait jetee.** `bringUpTunnel` appelle
 * `tunnels.markDown(name, gatewayUp ? 'no matching selector' :
 * 'negotiation failed')` — le verdict est donc calcule a l'endroit ou
 * il est connu — et `IpsecTunnelState.failure` etait ECRIT par cette
 * ligne et LU par personne dans tout le depot. Moteur qui note son
 * diagnostic et porte qui ne le relaie pas ; la CLI le lit desormais
 * par `stateOf`, l'accesseur qui existait.
 *
 * **Une cinquieme raison est ajoutee, et elle est la plus frequente** :
 * une phase 1 sans AUCUNE phase 2 attachee. Le boitier n'emet alors
 * rien du tout, donc « negotiation failed » decrivait une negociation
 * qui n'a jamais commence. La condition n'est PAS « l'entree de carte
 * de chiffrement existe-t-elle ? » — mesure faite plutot que supposee,
 * `programIpsecEngine` en cree une pour chaque phase 1 qu'il y ait un
 * selecteur ou non, donc ce predicat est toujours vrai et une premiere
 * version l'a lu a tort — mais `selectorsOf(name).length > 0`.
 *
 * Les deux refus de saisie n'inventent aucune formule de FortiOS : ils
 * REUTILISENT les deux messages que ce simulateur emploie deja partout
 * ailleurs pour ces deux cas, `incomplete` et `unknownKey`. La formule
 * exacte d'une vraie machine pour un nom de tunnel inconnu n'est pas
 * attestee depuis ce reseau, et l'inventer aurait remplace une phrase
 * fausse par une autre.
 *
 * Discrimine par `git stash push -- src/network/` : 7 des 9 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « un tunnel qui monte pour de bon ne dit rien » est le TEMOIN,
 *     et c'est son objet de passer des deux cotes : sans lui, une
 *     commande qui echouerait TOUJOURS satisferait tous les autres cas ;
 *   - « la phase 1 est bien montee quand les selecteurs discordent »
 *     lit l'etat du tunnel et non le message, donc il decrit ce que le
 *     moteur savait deja — c'est ce qui prouve que la raison relayee
 *     est mesuree et non devinee.
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
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`,
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next', 'end');
  return { fw, sh };
}

function phase1(sh: FortiShell, name: string, peer: string): void {
  run(sh, 'config vpn ipsec phase1-interface', `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2', `set remote-gw ${peer}`,
    `set psksecret "${PSK}"`, 'set proposal aes256-sha256', 'set dhgrp 14',
    'next', 'end');
}

function phase2(sh: FortiShell, name: string, local: string, remote: string): void {
  run(sh, 'config vpn ipsec phase2-interface', `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${local}.0 255.255.255.0`,
    `set dst-subnet ${remote}.0 255.255.255.0`, 'next', 'end');
}

function paire(distantB = '192.168.1') {
  const a = site('FGT-A', '192.168.1', '203.0.113.1', -200);
  const b = site('FGT-B', '192.168.2', '203.0.113.2', 200);
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);

  phase1(a.sh, 'vers_b', '203.0.113.2');
  phase2(a.sh, 'vers_b', '192.168.1', '192.168.2');
  phase1(b.sh, 'vers_a', '203.0.113.1');
  phase2(b.sh, 'vers_a', '192.168.2', distantB);

  return { a, b };
}

describe('diagnose vpn tunnel up', () => {
  it('sans nom, la commande est incomplete et ne parle pas du tunnel', () => {
    const { sh } = site('FGT', '192.168.1', '203.0.113.1', 0);

    const sortie = sh.execute('diagnose vpn tunnel up');
    expect(sortie).toContain('the tunnel name is missing');
    expect(sortie).not.toContain('did not come up');
  });

  it('un nom qui n existe pas est nomme comme tel', () => {
    const { sh } = site('FGT', '192.168.1', '203.0.113.1', 0);

    const sortie = sh.execute('diagnose vpn tunnel up zorglub');
    expect(sortie).toContain('"zorglub" does not exist');
    expect(sortie).not.toContain('did not come up');
  });

  it('une phase 1 sans phase 2 nomme le selecteur manquant', () => {
    const { sh } = site('FGT', '192.168.1', '203.0.113.1', 0);
    phase1(sh, 'vers_b', '203.0.113.2');

    expect(sh.execute('diagnose vpn tunnel up vers_b'))
      .toContain('no phase2 selector bound to this phase1');
  });

  it('un pair qui ne repond pas est une negociation en echec', () => {
    const un = site('FGT', '192.168.1', '203.0.113.1', 0);
    phase1(un.sh, 'vers_b', '203.0.113.2');
    phase2(un.sh, 'vers_b', '192.168.1', '192.168.2');

    const sortie = un.sh.execute('diagnose vpn tunnel up vers_b');
    expect(sortie).toContain('negotiation failed');
    expect(sortie).not.toContain('selector');
  });

  it('des selecteurs discordants ne sont pas une negociation en echec', () => {
    const { a } = paire('10.99.99');

    const sortie = a.sh.execute('diagnose vpn tunnel up vers_b');
    expect(sortie).toContain('no matching selector');
    expect(sortie).not.toContain('negotiation failed');
  });

  it('la phase 1 est bien montee quand les selecteurs discordent', () => {
    const { a } = paire('10.99.99');

    a.sh.execute('diagnose vpn tunnel up vers_b');

    const etat = a.fw.getTunnelTable().stateOf('vers_b');
    expect(etat?.gatewayUp).toBe(true);
    expect(etat?.status).toBe('down');
  });

  it('un tunnel qui monte pour de bon ne dit rien', () => {
    const { a } = paire();

    expect(a.sh.execute('diagnose vpn tunnel up vers_b')).toBe('');
    expect(a.fw.getTunnelTable().stateOf('vers_b')?.status).toBe('up');
  });

  it('la raison est effacee quand le tunnel finit par monter', () => {
    const un = site('FGT-A', '192.168.1', '203.0.113.1', -200);
    phase1(un.sh, 'vers_b', '203.0.113.2');
    un.sh.execute('diagnose vpn tunnel up vers_b');
    expect(un.fw.getTunnelTable().stateOf('vers_b')?.failure)
      .toBe('no phase2 selector bound to this phase1');

    phase2(un.sh, 'vers_b', '192.168.1', '192.168.2');
    un.sh.execute('diagnose vpn tunnel up vers_b');

    expect(un.fw.getTunnelTable().stateOf('vers_b')?.failure).toBe('negotiation failed');
  });

  it('la raison relayee est celle que le moteur a notee', () => {
    const { a } = paire('10.99.99');

    const sortie = a.sh.execute('diagnose vpn tunnel up vers_b');
    const notee = a.fw.getTunnelTable().stateOf('vers_b')?.failure;

    expect(notee).toBe('no matching selector');
    expect(sortie).toContain(notee!);
  });
});
