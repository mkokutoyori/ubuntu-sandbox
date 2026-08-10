/**
 * `display vrrp statistics` compte, et compte sous les VRAIS intitules.
 *
 * ── Le defaut, et il etait double ───────────────────────────────────
 *
 * 1. **Tous les compteurs valaient zero** : rien dans l'agent ne comptait
 *    une annonce emise ou recue. `PRD-CLI-Fidelite-VRP.md` §24.4 le
 *    signalait comme un fait, et il l'etait — mais le lot V16
 *    (authentification) l'a rendu genant, un refus d'authentification
 *    etant precisement ce qu'un operateur veut voir compte.
 *
 * 2. **Les intitules etaient INVENTES.** La vue annoncait
 *    `Advertisement sent`, `Advertisement received`, `Priority zero
 *    packets sent`, `Become master` et `Track interfaces` — **aucun** ne
 *    figure dans la sortie d'une vraie machine. Un apprenant qui compare
 *    sa capture a la notre ne retrouvait aucune ligne. Les dix-neuf
 *    champs de VRP et les quatre compteurs globaux sont releves sur sa
 *    documentation.
 *
 * ── Deux regles de protocole que les compteurs ont revelees ─────────
 *
 * Un compteur qui ne peut structurellement rien compter est le signe
 * qu'une regle manque :
 *
 * - **`Received ip ttl errors`** : RFC 5798 §5.1.1.3 exige un TTL de 255
 *   sur une annonce et fait ECARTER le paquet sinon — c'est ce qui
 *   garantit qu'elle n'a traverse aucun routeur, donc qu'elle vient du
 *   lien local. Le controle n'existait pas.
 * - **`Sent packets with priority zero`** : RFC 5798 §6.4.3 fait emettre
 *   au maitre qui s'arrete une annonce de priorite 0. Ce n'est pas une
 *   politesse : c'est ce qui fait basculer le secours TOUT DE SUITE au
 *   lieu de lui faire attendre l'intervalle de maitre absent. Un
 *   laboratoire ou l'on coupe proprement un maitre et ou le basculement
 *   prend trois secondes enseignerait que VRRP est lent alors qu'il ne
 *   l'est que sur une PANNE.
 *
 * ── Les zeros qui restent sont des FAITS, et ils sont nommes ────────
 *
 * Ce simulateur ne serialise pas ses paquets VRRP — ils voyagent comme
 * objets — donc il n'existe ni somme de controle a fausser, ni longueur
 * a tronquer, ni octet de version a corrompre, ni type invalide :
 * `handleIp` n'accepte qu'une charge utile deja typee. Ces compteurs-la
 * valent zero parce que l'evenement ne peut pas se produire, ce qui
 * n'est pas la meme chose que de ne pas savoir le compter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_VRRP, VRRP_MULTICAST_IP } from '@/network/vrrp/types';
import type { VrrpPacket } from '@/network/vrrp/types';
import type { IPv4Packet } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

async function paire(o: { confA?: string[]; confB?: string[] } = {}) {
  const a = new HuaweiRouter(`A${++serie}`);
  const b = new HuaweiRouter(`B${serie}`);
  new Cable(`s${serie}`).connect(a.getPort('GE0/0/0')!, b.getPort('GE0/0/0')!);
  const monter = async (r: HuaweiRouter, ip: string, prio: number, extra: string[]) => {
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      `ip address ${ip} 255.255.255.0`, 'undo shutdown', ...extra,
      'vrrp vrid 1 virtual-ip 10.0.0.254', `vrrp vrid 1 priority ${prio}`,
      'return']) await r.executeCommand(c);
  };
  await monter(b, '10.0.0.2', 100, o.confB ?? []);
  await monter(a, '10.0.0.1', 200, o.confA ?? []);
  return { a, b };
}

const stats = (r: HuaweiRouter) => {
  const ag = r.getVrrpAgent();
  const g = [...ag.getConfig().groups.values()][0];
  return ag.stats(g);
};

describe('les intitules sont ceux d\'une vraie machine', () => {
  it('les quatre compteurs GLOBAUX precedent les groupes', async () => {
    const { a } = await paire();
    const out = await a.executeCommand('display vrrp statistics');
    expect(out.split('\n').slice(0, 4)).toEqual([
      '  Checksum errors : 0',
      '  Version errors : 0',
      '  Vrid errors : 0',
      '  Other errors : 0',
    ]);
  });

  it('les dix-neuf champs du groupe sont la, dans l\'ordre de VRP', async () => {
    const { a } = await paire();
    const out = await a.executeCommand('display vrrp statistics');
    const attendus = [
      'Transited to master', 'Transited to backup', 'Transited to initialize',
      'Received advertisements', 'Sent advertisements',
      'Advertisement interval errors', 'Failed to authentication check',
      'Received ip ttl errors', 'Received packets with priority zero',
      'Sent packets with priority zero', 'Received invalid type packets',
      'Received unmatched address list packets', 'Unknown authentication type packets',
      'Mismatched authentication type', 'Packet length errors',
      'Discarded packets since track admin-vrrp', 'Received attacking packets',
      'Received selfsend packets', 'Sent gratuitous arp packets',
    ];
    const vus = out.split('\n')
      .map((l) => l.trim().split(' : ')[0]).filter((n) => attendus.includes(n));
    expect(vus).toEqual(attendus);
  });

  it('les intitules INVENTES ont disparu', async () => {
    // Aucun de ces cinq ne figure dans la sortie d'une vraie machine.
    const { a } = await paire();
    const out = await a.executeCommand('display vrrp statistics');
    for (const invente of ['Advertisement sent', 'Advertisement received',
      'Priority zero packets sent', 'Become master', 'Track interfaces']) {
      expect(out, invente).not.toContain(invente);
    }
  });
});

describe('les compteurs sont MESURES', () => {
  it('les annonces emises et recues sont comptees des deux cotes', async () => {
    const { a, b } = await paire();
    expect(stats(a).sentAdvertisements).toBeGreaterThan(0);
    expect(stats(b).receivedAdvertisements).toBeGreaterThan(0);
    // La propriete qui fait de ces nombres un comptage : ce que `a` a
    // emis, `b` l'a recu — a l'annonce initiale de `b` pres, qui part
    // avant que `a` n'existe.
    expect(stats(b).receivedAdvertisements).toBeLessThanOrEqual(stats(a).sentAdvertisements);
  });

  it('les transitions d\'etat sont comptees, chacune dans son champ', async () => {
    const { a, b } = await paire();
    expect(stats(a).transitedToMaster).toBeGreaterThan(0);
    expect(stats(b).transitedToBackup).toBeGreaterThan(0);
  });

  it('l\'ARP gratuit de la prise de role est compte', async () => {
    // Il est emis depuis toujours (RFC 5798 §6.4.1) et n'etait compte
    // nulle part.
    const { a } = await paire();
    expect(stats(a).sentGratuitousArp).toBe(stats(a).transitedToMaster);
  });

  it('un echec d\'authentification est compte, et le TYPE a son propre champ', async () => {
    const { b } = await paire({
      confA: ['vrrp vrid 1 authentication-mode simple CelleDeA'],
      confB: ['vrrp vrid 1 authentication-mode simple CelleDeB'],
    });
    expect(stats(b).failedAuthCheck).toBeGreaterThan(0);
    expect(stats(b).mismatchedAuthType).toBe(0);
  });

  it('un desaccord de MODE compte dans l\'autre champ', async () => {
    // Les deux motifs envoient l'operateur a deux endroits : une
    // commande qui manque, ou un secret qui differe.
    const { b } = await paire({
      confA: ['vrrp vrid 1 authentication-mode md5 LeSecret'],
      confB: ['vrrp vrid 1 authentication-mode simple LeSecret'],
    });
    expect(stats(b).mismatchedAuthType).toBeGreaterThan(0);
    expect(stats(b).failedAuthCheck).toBe(0);
  });

  it('un intervalle d\'annonce discordant est compte', async () => {
    const { b } = await paire({ confA: ['vrrp vrid 1 timer advertise 3'] });
    expect(stats(b).advertisementIntervalErrors).toBeGreaterThan(0);
  });
});

describe('deux regles de protocole que les compteurs ont revelees', () => {
  /** Injecter une annonce fabriquee, pour eprouver le CONTROLE et non l'emetteur. */
  function injecter(cible: HuaweiRouter, ttl: number, senderIp: string): void {
    const pkt: VrrpPacket = {
      type: 'vrrp', version: 2, vrid: 1, priority: 150,
      advertiseSec: 1, vips: ['10.0.0.254'], senderIp,
      authType: 0,
    };
    const ip: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 28,
      identification: 1, flags: 0, fragmentOffset: 0,
      ttl, protocol: IP_PROTO_VRRP, headerChecksum: 0,
      sourceIP: new IPAddress(senderIp),
      destinationIP: new IPAddress(VRRP_MULTICAST_IP),
      payload: pkt,
    };
    cible.getVrrpAgent().handleIp('GE0/0/0', new IPAddress(senderIp), ip);
  }

  it('une annonce dont le TTL n\'est pas 255 est ECARTEE et comptee', async () => {
    // RFC 5798 §5.1.1.3. Le controle n'existait pas : une annonce ayant
    // traverse un routeur — donc venue d'ailleurs que du lien local —
    // etait acceptee comme une voisine.
    const { b } = await paire();
    const avant = stats(b).receivedAdvertisements;
    injecter(b, 64, '10.0.0.9');
    expect(stats(b).receivedIpTtlErrors).toBe(1);
    expect(stats(b).receivedAdvertisements).toBe(avant);
  });

  it('avec un TTL de 255, la meme annonce est acceptee', async () => {
    // Le temoin : sans lui, un controle « qui marche » serait
    // indiscernable d'une injection qui n'arrive nulle part.
    const { b } = await paire();
    const avant = stats(b).receivedAdvertisements;
    injecter(b, 255, '10.0.0.9');
    expect(stats(b).receivedAdvertisements).toBe(avant + 1);
    expect(stats(b).receivedIpTtlErrors).toBe(0);
  });

  it('une annonce emise par NOUS-MEMES ne compte pas comme une voisine', async () => {
    const { b } = await paire();
    const avant = stats(b).receivedAdvertisements;
    injecter(b, 255, '10.0.0.2');
    expect(stats(b).receivedSelfsend).toBe(1);
    expect(stats(b).receivedAdvertisements).toBe(avant);
  });

  it('une liste d\'adresses qui ne correspond pas est comptee', async () => {
    const { b } = await paire();
    const pkt: VrrpPacket = {
      type: 'vrrp', version: 2, vrid: 1, priority: 150,
      advertiseSec: 1, vips: ['10.0.0.99'], senderIp: '10.0.0.9', authType: 0,
    };
    b.getVrrpAgent().handleIp('GE0/0/0', new IPAddress('10.0.0.9'), {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 28,
      identification: 1, flags: 0, fragmentOffset: 0,
      ttl: 255, protocol: IP_PROTO_VRRP, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.9'),
      destinationIP: new IPAddress(VRRP_MULTICAST_IP), payload: pkt,
    });
    expect(stats(b).receivedUnmatchedAddressList).toBe(1);
  });

  it('un maitre qui part DEMISSIONNE par une annonce de priorite zero', async () => {
    // RFC 5798 §6.4.3. Sans elle, le secours attendrait l'intervalle de
    // maitre absent — donc un laboratoire ou l'on coupe proprement le
    // maitre enseignerait que VRRP est lent.
    const { a, b } = await paire();
    // Les compteurs sont saisis AVANT le retrait : `undo vrrp vrid`
    // supprime le groupe, donc l'objet ne serait plus joignable apres —
    // et c'est bien le meme objet, pas une copie.
    const compteursDeA = stats(a);
    expect(compteursDeA.sentPriorityZero).toBe(0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'undo vrrp vrid 1', 'return']) await a.executeCommand(c);
    expect(compteursDeA.sentPriorityZero).toBe(1);
    expect(stats(b).receivedPriorityZero).toBe(1);
    // Et le secours a repris tout de suite.
    const g = [...b.getVrrpAgent().getConfig().groups.values()][0];
    expect(g.state).toBe('master');
  });
});

describe('`reset vrrp statistics` remet vraiment a zero', () => {
  it('la commande existe et vide les compteurs', async () => {
    // Elle etait absente : un operateur ne pouvait pas repartir d'un
    // comptage propre avant une mesure.
    const { a } = await paire();
    expect(stats(a).sentAdvertisements).toBeGreaterThan(0);
    await a.executeCommand('reset vrrp statistics');
    expect(stats(a).sentAdvertisements).toBe(0);
    expect(stats(a).transitedToMaster).toBe(0);
  });
});
