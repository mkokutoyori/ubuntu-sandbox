/**
 * Un réassemblage qui expire le DIT — RFC 1122 §3.3.2.
 *
 * MESURE DE DEPART. La RFC est explicite : « If a timeout occurs on a
 * partially reassembled datagram, an ICMP Time Exceeded (Time to Live
 * exceeded in reassembly, code 1) message MUST be sent to the source
 * host, if and only if fragment zero has been received. »
 *
 * Tout etait en place SAUF l'envoi. `IPv4Reassembler` porte un minuteur
 * (`REASSEMBLY_TIMEOUT_MS`), un balayage (`purgeExpired`) et un rappel
 * `onExpire` qui cherche DEJA le fragment d'offset zero — c'est-a-dire
 * exactement la condition « si et seulement si » de la RFC. Et
 * `ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED = 1` est declaree dans
 * `core/IcmpErrors.ts`.
 *
 * **Mesure** : `grep -rn ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED src/` ne
 * rendait QUE sa propre declaration. Une constante rangee et lue par
 * personne — le defaut que ce depot passe son temps a refermer. Les
 * trois recepteurs se comportaient en outre differemment sans qu'aucune
 * regle ne le decide : le pare-feu passait un rappel (qui comptait un
 * echec et liberait la memoire, sans rien emettre), tandis que `Router`
 * et `EndHost` construisaient leur reassembleur SANS rappel du tout.
 *
 * CE QU'IL A FALLU AJOUTER, et rien de plus : le rappel ne recevait que
 * le fragment, pas l'interface d'ARRIVEE, et `Router.sendICMPError`
 * exige un port valide pour choisir son adresse source. `add()` prend
 * donc un troisieme argument facultatif que l'entree en attente
 * conserve et que `purgeExpired` rend au rappel.
 *
 * DISCRIMINATION (`git stash` sur les cinq fichiers) : 3 des 8 cas
 * tombent — l'interface d'arrivee, les trois lecteurs de la constante,
 * et l'absence de reassembleur construit nu.
 *
 * Les 5 autres sont nommes plutot que comptes, et leur repartition dit
 * exactement ou etait le defaut : le fragment ZERO, le NULL quand il
 * manque, les deux TEMOINS d'echeance et la valeur du code passaient
 * DEJA. C'est le fond du lot — le mecanisme etait entierement bati, la
 * condition « si et seulement si » de la RFC etait deja evaluee, et il
 * ne manquait que l'EMISSION. Sans ces cinq, on croirait avoir ecrit un
 * minuteur alors qu'on n'a branche qu'un fil.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IPv4Reassembler, REASSEMBLY_TIMEOUT_MS, fragmentIPv4, IPV4_FLAG_DF,
} from '@/network/core/Ipv4Fragmentation';
import {
  resetCounters, MACAddress, IPAddress, createIPv4Packet, IP_PROTO_ICMP,
} from '@/network/core/types';
import type { IPv4Packet } from '@/network/core/types';
import { ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED } from '@/network/core/IcmpErrors';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function fragmentsDe(charge: number): IPv4Packet[] {
  const entier = createIPv4Packet(
    new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'),
    IP_PROTO_ICMP, 64, { type: 'icmp' }, charge, { flags: 0 });
  return fragmentIPv4(entier, 600);
}

describe('le rappel d\'expiration porte ce que la RFC exige', () => {
  it('il rend le fragment ZERO, condition du « si et seulement si »', () => {
    const vus: Array<IPv4Packet | null> = [];
    const r = new IPv4Reassembler((premier) => { vus.push(premier); });
    const frags = fragmentsDe(1400);
    expect(frags.length).toBeGreaterThan(1);

    r.add(frags[0], 0, 'eth0');
    r.purgeExpired(REASSEMBLY_TIMEOUT_MS + 1);

    expect(vus).toHaveLength(1);
    expect(vus[0]).not.toBeNull();
    expect(vus[0]!.fragmentOffset).toBe(0);
  });

  it('il rend NULL quand le fragment zero n\'est jamais arrive', () => {
    const vus: Array<IPv4Packet | null> = [];
    const r = new IPv4Reassembler((premier) => { vus.push(premier); });
    const frags = fragmentsDe(1400);

    r.add(frags[1], 0, 'eth0');
    r.purgeExpired(REASSEMBLY_TIMEOUT_MS + 1);

    expect(vus).toHaveLength(1);
    expect(vus[0]).toBeNull();
  });

  it('et il rend l\'interface d\'ARRIVEE, sans laquelle rien ne peut repondre', () => {
    const vus: Array<string | undefined> = [];
    const r = new IPv4Reassembler((_p, iface) => { vus.push(iface); });
    r.add(fragmentsDe(1400)[0], 0, 'GigabitEthernet0/3');
    r.purgeExpired(REASSEMBLY_TIMEOUT_MS + 1);
    expect(vus).toEqual(['GigabitEthernet0/3']);
  });

  it('TEMOIN — un ensemble COMPLET n\'expire pas', () => {
    let expirations = 0;
    const r = new IPv4Reassembler(() => { expirations += 1; });
    const frags = fragmentsDe(1400);
    let entier: IPv4Packet | null = null;
    for (const f of frags) entier = r.add(f, 0, 'eth0') ?? entier;
    r.purgeExpired(REASSEMBLY_TIMEOUT_MS + 1);
    expect(entier).not.toBeNull();
    expect(expirations).toBe(0);
  });

  it('TEMOIN — avant l\'echeance, rien n\'expire', () => {
    let expirations = 0;
    const r = new IPv4Reassembler(() => { expirations += 1; });
    r.add(fragmentsDe(1400)[0], 0, 'eth0');
    r.purgeExpired(REASSEMBLY_TIMEOUT_MS - 1);
    expect(expirations).toBe(0);
  });
});

describe('et le code ICMP de la RFC 1122 §3.3.2 est enfin LU', () => {
  it('le type 11 code 1 est bien celui du reassemblage', () => {
    expect(ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED).toBe(1);
  });

  it('les trois recepteurs le lisent, la constante n\'est plus orpheline', async () => {
    const { readFileSync } = await import('node:fs');
    const lecteurs = [
      'src/network/devices/Router.ts',
      'src/network/devices/EndHost.ts',
      'src/network/devices/firewall/Firewall.ts',
    ].filter((f) => readFileSync(f, 'utf8')
      .includes('ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED'));
    expect(lecteurs).toHaveLength(3);
  });

  it('et aucun reassembleur d\'equipement n\'est construit SANS rappel', async () => {
    const { readFileSync } = await import('node:fs');
    const nus = [
      'src/network/devices/Router.ts',
      'src/network/devices/EndHost.ts',
    ].filter((f) => readFileSync(f, 'utf8').includes('new IPv4Reassembler()'));
    expect(nus).toEqual([]);
  });
});
