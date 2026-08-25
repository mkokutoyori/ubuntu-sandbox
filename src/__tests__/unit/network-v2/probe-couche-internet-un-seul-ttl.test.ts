/**
 * Un seul lieu decremente un TTL — phase 2, increment 1.
 *
 * MESURE DE DEPART (BRD §2.2) : cinq corps decrementaient un TTL,
 * chacun refaisant la meme sequence — decrementer, verifier
 * l'expiration, recalculer la somme de controle d'en-tete :
 *
 *   Router.forwardPacket        routeur, unicast
 *   Router.forwardMulticast     routeur, multicast
 *   EndHost.forwardIPv4         hote qui fait suivre
 *   SwitchSvi.forwardIpPacket   commutateur de niveau 3
 *   coreStages (pare-feu)       etape du pipeline
 *
 * Quatre familles d'equipements, cinq ecritures, et le BRD rappelle que
 * ce depot a deja paye TROIS divergences sur exactement ces chemins.
 *
 * CE QUE LA MESURE A CORRIGE DE MES PROPRES SUPPOSITIONS, et qui est
 * ecrit ici parce que c'est la seule raison pour laquelle ce lot ne
 * change AUCUN comportement : j'ai d'abord cru que `SwitchSvi`
 * decrementait sans garde — `{ ...ip, ttl: ip.ttl - 1 }` n'a pas de
 * verification a cote — donc qu'il emettait des paquets a TTL 0 et
 * restait invisible au traceroute. C'est faux : sa garde est en tete de
 * `forwardIpPacket`, ecrite `ttl <= 1` AVANT le decrement la ou le
 * routeur ecrit `ttl - 1 <= 0` APRES. Les deux formulations sont
 * equivalentes. Les cinq sites etaient donc d'accord, et ce lot est une
 * deduplication pure : c'est ce que le §4.1 du BRD exige de chaque
 * phase.
 *
 * DISCRIMINATION : UN seul des 7 cas tombe avant correctif — « aucun
 * equipement ne decremente un TTL a la main » —, et c'est exact : le
 * defaut etait unique et purement structurel. Les 6 autres sont nommes
 * ici plutot que de gonfler le compte :
 *  - les 5 cas de la RFC 1812 verifient la REGLE, et la regle ne change
 *    pas : ils passent des deux cotes et LE DOIVENT, puisque deplacer
 *    une regle sans la modifier ne change rien de ce que la machine
 *    repond. Sans eux, la deduplication ne serait garantie par
 *    personne — rien n'empecherait qu'on la deplace ET qu'on la casse.
 *  - « la couche est le seul endroit qui le fasse » passe des deux
 *    cotes parce que `git stash` ne retire pas le fichier de couche,
 *    qui est nouveau : il garde qu'un SIXIEME site n'apparaisse pas
 *    dans `layers/`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decrementForForwarding } from '@/network/layers/internet/InternetLayer';
import { createIPv4Packet, computeIPv4Checksum, IPAddress, IP_PROTO_ICMP } from '@/network/core/types';

function fichiersTs(racine: string): string[] {
  const out: string[] = [];
  for (const entree of readdirSync(racine)) {
    const chemin = join(racine, entree);
    if (statSync(chemin).isDirectory()) out.push(...fichiersTs(chemin));
    else if (entree.endsWith('.ts')) out.push(chemin);
  }
  return out;
}

describe('la regle du TTL vit dans la couche internet', () => {
  it('aucun equipement ne decremente un TTL a la main', () => {
    const coupables = fichiersTs('src/network/devices')
      .filter((f) => /\bttl\s*-\s*1\b|\bttl\s*-=\s*1\b/.test(readFileSync(f, 'utf8')));
    expect(coupables).toEqual([]);
  });

  it('et la couche est le seul endroit qui le fasse', () => {
    const dansLaCouche = fichiersTs('src/network/layers')
      .filter((f) => /\bttl\s*-\s*1\b/.test(readFileSync(f, 'utf8')));
    expect(dansLaCouche).toEqual(['src/network/layers/internet/InternetLayer.ts']);
  });
});

describe('et la regle est celle de la RFC 1812 §5.3.1', () => {
  const paquet = (ttl: number) => createIPv4Packet(
    new IPAddress('10.0.0.1'), new IPAddress('10.0.1.1'), IP_PROTO_ICMP, ttl, {}, 8);

  it('un TTL de 1 expire — il n\'y a plus de saut a offrir', () => {
    expect(decrementForForwarding(paquet(1)).kind).toBe('expired');
  });

  it('un TTL de 0 expire aussi', () => {
    expect(decrementForForwarding(paquet(0)).kind).toBe('expired');
  });

  it('un TTL de 2 passe a 1 et reste acheminable', () => {
    const d = decrementForForwarding(paquet(2));
    expect(d.kind).toBe('forward');
    if (d.kind !== 'forward') return;
    expect(d.packet.ttl).toBe(1);
  });

  it('la somme de controle d\'en-tete est RECALCULEE, pas recopiee', () => {
    const avant = paquet(64);
    const d = decrementForForwarding(avant);
    expect(d.kind).toBe('forward');
    if (d.kind !== 'forward') return;
    expect(d.packet.headerChecksum).not.toBe(avant.headerChecksum);
    expect(d.packet.headerChecksum)
      .toBe(computeIPv4Checksum({ ...d.packet, headerChecksum: 0 }));
  });

  it('le paquet d\'origine n\'est pas modifie', () => {
    const avant = paquet(64);
    decrementForForwarding(avant);
    expect(avant.ttl).toBe(64);
  });
});
