/**
 * `peertype` etait declare, rendu, et n'ecartait AUCUN pair.
 *
 * Le schema declarait trois de ses cinq valeurs et le moteur IKE ne les
 * lisait pas : `peerid` et `localid` n'existaient meme pas comme
 * attributs. Un tunnel regle en `set peertype one` acceptait donc
 * n'importe quelle identite, ce qui est exactement le contraire de ce
 * que la commande promet — c'est le controle par lequel un concentrateur
 * distingue un pair legitime d'un inconnu qui connait la cle.
 *
 * **La correction est dans le PROTOCOLE et non dans le pare-feu**, et
 * c'est la regle de ce chantier. `IkeOfferMessage.identity` existe
 * depuis toujours : la charge d'identite VOYAGE, et le repondeur la
 * lisait deja pour choisir la cle partagee — c'est ce qui fait marcher
 * `crypto isakmp key … hostname` cote Cisco. Ce qui manquait au moteur
 * etait de savoir qu'une entree peut RESTREINDRE les identites
 * acceptees. `CryptoMapEntry` porte desormais deux notions generiques :
 * `localIdentity`, l'identite annoncee, et `acceptedPeerIdentities`, la
 * liste de celles qu'on accepte — `undefined` voulant dire « toutes »,
 * donc le comportement d'avant pour tout ce qui ne configure rien.
 *
 * **Deux plafonds du moteur sont leves au passage.** L'identite annoncee
 * etait choisie par des reglages d'EQUIPEMENT (`crypto isakmp identity`)
 * ou de PROFIL, tous deux propres a IOS, alors que FortiOS la regle par
 * TUNNEL ; et sous IKEv2 elle etait l'adresse source apparente, sans
 * aucune facon de la changer — `localid` y aurait ete inapplicable. Les
 * deux passent par `entry.localIdentity`, qui vaut pour les deux
 * versions, les anciennes sources restant le repli.
 *
 * **Le refus est FERME**, et deux cas l'epinglent : `peertype one` sans
 * `peerid` n'accepte personne plutot que tout le monde, et un `peerid`
 * qui ne correspond pas fait echouer la negociation au lieu de la
 * laisser passer. C'est la posture de ce depot pour un critere de
 * securite : ce qu'on ne peut pas trancher ne passe pas.
 *
 * **`dialup` resout un GROUPE**, ce que le moteur n'a pas a connaitre :
 * `IpsecIdentitySources` est le port etroit par lequel le pare-feu lui
 * donne les membres, et le moteur ne voit qu'une liste d'identites. Le
 * laboratoire de ces deux cas emploie la vraie forme d'un acces
 * distant — un repondeur `set type dynamic`, sans passerelle distante
 * fixe — parce que `authusrgrp` n'est offert que la, et que la mesure
 * l'a montre : monte sur un tunnel statique, `set authusrgrp` est refuse
 * et les deux cas tombaient pour cette raison-la et non pour l'identite.
 *
 * **EXIGER une identite et en CONTRAINDRE une sont deux postures**, et
 * c'est une regression sur un laboratoire existant qui l'a impose. Le
 * TP 18 monte un acces teletravailleur reel : le client ne pose AUCUN
 * `localid` et s'authentifie par XAuth, donc son identite IKE est sa
 * propre adresse source — ce que tout pair annonce quand aucune n'est
 * configuree, et non un identifiant de pair. Restreindre la-dessus
 * refusait un montage qu'une vraie machine accepte. `CryptoMapEntry`
 * porte donc `requirePeerIdentity` a cote de la liste : `one` EXIGE une
 * identite et refuse un pair qui n'annonce que son adresse, tandis que
 * `dialup` se contente de CONTRAINDRE celle qui est annoncee et laisse
 * l'authentification par XAuth faire le reste. Les deux sont de vraies
 * postures IKE, et la distinction n'est pas une facilite : c'est celle
 * entre un identifiant de type ID_IPV4_ADDR, que le protocole remplit
 * tout seul, et un ID_FQDN que l'operateur a choisi.
 *
 * **`peer` et `peergrp` sont REFUSES en nommant la brique qui manque** :
 * ils acceptent un CERTIFICAT de pair, et ce simulateur n'a ni `config
 * user peer` ni `config user peergrp`.
 *
 * Discrimine par `git stash push -- src/network/` : 6 des 11 cas
 * tombent. Les 5 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « sans reglage, le tunnel monte » est le TEMOIN ;
 *   - « annoncer une identite ne casse pas un pair qui accepte tout »,
 *     « peertype one avec le bon peerid laisse monter le tunnel » et
 *     « peertype dialup accepte un membre du groupe » passaient par
 *     VACUITE : aucune identite n'etait verifiee, donc tout montait ;
 *     ils valent desormais pour les trois chemins d'acceptation, et
 *     leurs jumeaux negatifs portent la mesure ;
 *   - « peerid n'est offert que sous peertype one » passait parce que
 *     l'attribut n'existait pas du tout, donc le refus etait
 *     indiscernable de l'absence ; il vaut desormais pour la condition.
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

function site(name: string, lan: string, wan: string): Site {
  const fw = new FortiGate('firewall-fortinet', name, 0, 0);
  const sh = new FortiShell(fw);
  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next',
    'edit "port2"', 'set mode static', `set ip ${wan} 255.255.255.0`,
    'set allowaccess ping', 'next', 'end');
  return { fw, sh };
}

function phase2(sh: FortiShell, name: string, local: string, remote: string): void {
  run(sh, 'config vpn ipsec phase2-interface', `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${local}.0 255.255.255.0`,
    `set dst-subnet ${remote}.0 255.255.255.0`, 'next', 'end');
}

function tunnelStatique(
  s: Site, name: string, peer: string, local: string, remote: string,
  extra: readonly string[] = [],
): void {
  run(s.sh, 'config vpn ipsec phase1-interface', `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2',
    `set remote-gw ${peer}`, 'set psksecret "SecretPartage2026"',
    'set proposal aes256-sha256', 'set dhgrp 14', ...extra, 'next', 'end');
  phase2(s.sh, name, local, remote);
}

function tunnelDistant(
  s: Site, name: string, local: string, remote: string,
  extra: readonly string[] = [],
): void {
  run(s.sh, 'config vpn ipsec phase1-interface', `edit "${name}"`,
    'set interface "port2"', 'set ike-version 2', 'set type dynamic',
    'set psksecret "SecretPartage2026"',
    'set proposal aes256-sha256', 'set dhgrp 14', ...extra, 'next', 'end');
  phase2(s.sh, name, local, remote);
}

function paire() {
  const a = site('FGT-A', '192.168.1', '203.0.113.1');
  const b = site('FGT-B', '192.168.2', '203.0.113.2');
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);
  return { a, b };
}

function laboratoire(
  reglagesA: readonly string[] = [], reglagesB: readonly string[] = [],
) {
  const { a, b } = paire();
  tunnelStatique(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2', reglagesA);
  tunnelStatique(b, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1', reglagesB);
  a.fw.bringUpIpsecTunnel('vers_b');
  return { a, b };
}

function laboratoireDistant(identiteAnnoncee: string) {
  const { a, b } = paire();
  run(b.sh, 'config user local', 'edit "alice"', 'set type password',
    'set passwd "Aa1!aaaa"', 'next', 'end',
    'config user group', 'edit "VPNUSERS"', 'set member "alice"', 'next', 'end');
  tunnelStatique(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2',
    [`set localid "${identiteAnnoncee}"`]);
  tunnelDistant(b, 'vers_a', '192.168.2', '192.168.1',
    ['set peertype dialup', 'set authusrgrp "VPNUSERS"']);
  a.fw.bringUpIpsecTunnel('vers_b');
  return { a, b };
}

function monte(fw: FortiGate, pair: string): boolean {
  return fw.getIpsecEngine().getIPSecSAs(pair).length > 0;
}

const PAIR_B = '203.0.113.2';

describe('l_identite de pair IKE', () => {
  it('sans reglage, le tunnel monte', () => {
    const { a } = laboratoire();

    expect(monte(a.fw, PAIR_B)).toBe(true);
  });

  it('localid est accepte et rendu', () => {
    const { a } = laboratoire(['set localid "site-a.lab"']);

    expect(a.sh.execute('show vpn ipsec phase1-interface'))
      .toContain('set localid "site-a.lab"');
  });

  it('annoncer une identite ne casse pas un pair qui accepte tout', () => {
    const { a } = laboratoire(['set localid "site-a.lab"']);

    expect(monte(a.fw, PAIR_B)).toBe(true);
  });

  it('peertype one avec le bon peerid laisse monter le tunnel', () => {
    const { a } = laboratoire(['set localid "site-a.lab"'],
      ['set peertype one', 'set peerid "site-a.lab"']);

    expect(monte(a.fw, PAIR_B)).toBe(true);
  });

  it('peertype one avec un peerid different REFUSE la negociation', () => {
    const { a } = laboratoire(['set localid "site-a.lab"'],
      ['set peertype one', 'set peerid "autre.lab"']);

    expect(monte(a.fw, PAIR_B)).toBe(false);
  });

  it('peertype one sans peerid n_accepte personne', () => {
    const { a } = laboratoire(['set localid "site-a.lab"'], ['set peertype one']);

    expect(monte(a.fw, PAIR_B)).toBe(false);
  });

  it('peertype dialup accepte un membre du groupe', () => {
    const { a } = laboratoireDistant('alice');

    expect(monte(a.fw, PAIR_B)).toBe(true);
  });

  it('peertype dialup refuse une identite hors du groupe', () => {
    const { a } = laboratoireDistant('mallory');

    expect(monte(a.fw, PAIR_B)).toBe(false);
  });

  it('peertype peer est refuse en nommant la brique qui manque', () => {
    const { a } = paire();
    run(a.sh, 'config vpn ipsec phase1-interface', 'edit "t"');

    expect(a.sh.execute('set peertype peer')).toContain('config user peer');
    a.sh.execute('abort');
  });

  it('peertype peergrp est refuse de meme', () => {
    const { a } = paire();
    run(a.sh, 'config vpn ipsec phase1-interface', 'edit "t"');

    expect(a.sh.execute('set peertype peergrp')).toContain('config user peergrp');
    a.sh.execute('abort');
  });

  it('peerid n_est offert que sous peertype one', () => {
    const { a } = paire();
    run(a.sh, 'config vpn ipsec phase1-interface', 'edit "t"');

    expect(a.sh.execute('set peerid "x"')).toMatch(/Command fail/);
    a.sh.execute('abort');
  });
});
