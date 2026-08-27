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
 *
 * DISCRIMINATION DE L'INCREMENT 2 (les 7 derniers cas), mesuree en
 * rendant a HEAD les seuls fichiers d'EQUIPEMENT et en gardant la
 * couche : 2 tombent — les deux cas structurels. Les 5 autres decrivent
 * la REGLE de la RFC 1112 et passent des deux cotes, pour la meme raison
 * que ceux de l'increment 1 : la regle ne change pas, seul son lieu
 * change, et sans eux rien n'empecherait de la deplacer ET de la casser.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyIpv4Destination, decrementForForwarding,
} from '@/network/layers/internet/InternetLayer';
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

/**
 * INCREMENT 2 — la CLASSE d'une destination IPv4 se decide en un lieu.
 *
 * Mesure : le routeur decoupait l'adresse a la main
 * (`destOctets[0] >= 224 && destOctets[0] <= 239`) pendant que l'hote
 * appelait `isMulticastIpv4` pour la meme question — deux ecritures d'un
 * meme predicat, dont une recopiee. Et seul le routeur distinguait le
 * multicast LIEN-LOCAL (224.0.0.0/24, que la RFC 1112 interdit
 * d'acheminer) du multicast routable : l'hote les confondait, ce qui ne
 * se voyait pas parce qu'un hote n'achemine pas.
 */
describe('la classe d\'une destination IPv4 se decide en un lieu', () => {
  const adresse = (t: string) => new IPAddress(t);

  it('la diffusion limitee est reconnue', () => {
    expect(classifyIpv4Destination(adresse('255.255.255.255')))
      .toBe('limited-broadcast');
  });

  it('224.0.0.0/24 est du multicast LIEN-LOCAL, jamais achemine', () => {
    for (const t of ['224.0.0.1', '224.0.0.5', '224.0.0.251', '224.0.0.255']) {
      expect(classifyIpv4Destination(adresse(t))).toBe('link-local-multicast');
    }
  });

  it('224.0.1.0 et au-dela est du multicast routable', () => {
    for (const t of ['224.0.1.1', '239.255.255.250', '232.1.2.3']) {
      expect(classifyIpv4Destination(adresse(t))).toBe('multicast');
    }
  });

  it('les bornes du bloc multicast sont celles de la RFC 1112', () => {
    expect(classifyIpv4Destination(adresse('223.255.255.255'))).toBe('unicast');
    expect(classifyIpv4Destination(adresse('240.0.0.1'))).toBe('unicast');
  });

  it('une adresse ordinaire reste unicast', () => {
    expect(classifyIpv4Destination(adresse('10.0.0.1'))).toBe('unicast');
  });

  /**
   * Le garde-fou lit le CODE et non la prose : `Router.ts` cite encore
   * « 224.0.0.0/24 » et « 224.0.1.0-239.255.255.255 » dans ses
   * commentaires, ce qui est juste et doit le rester. Ce qu'on interdit
   * est l'IDIOME — comparer un octet aux bornes du bloc.
   *
   * ET LA PORTEE EST CELLE DU PLAN DE DONNEES, ce que la mesure a
   * impose plutot que l'inverse : passe sur tout `devices/`, ce cas
   * attrapait trois fichiers qui ne sont pas des acheminements et qui
   * ont RAISON d'ecrire ces bornes — `CiscoDhcpCommands` refuse une
   * option d'adresse qui ne serait pas unicast (`o[0] === 0 ||
   * o[0] >= 224`), `CiscoRoutingProtoCommands` en fait autant pour un
   * reseau (`first > 0 && first < 224 && first !== 127`). Ce sont des
   * grammaires d'ARGUMENT et non des classes de destination : elles
   * repondent « l'operateur a-t-il le droit de taper cela », question
   * dont 0 et 127 font partie et que `classifyIpv4Destination` ne
   * tranche pas — 240.0.0.1 y est unicast. Le garde-fou porte donc sur
   * les fichiers qui lisent la destination d'un VRAI paquet
   * (`destinationIP`), c'est-a-dire ceux qui en decident le sort.
   *
   * Le troisieme, `TcpdumpFilter`, etait en revanche une COPIE :
   * `isMulticastIp` redisait `isMulticastIpv4` mot pour mot, et il
   * delegue desormais.
   */
  it('aucun plan de donnees ne redecoupe le bloc multicast a la main', () => {
    const idiome = /[><=]=?\s*224\b|\b239\s*[><=]|[><=]=?\s*239\b/;
    const sansCommentaire = (t: string) => t
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const coupables = fichiersTs('src/network/devices')
      .map((f) => [f, sansCommentaire(readFileSync(f, 'utf8'))] as const)
      .filter(([, t]) => t.includes('destinationIP') && idiome.test(t))
      .map(([f]) => f);
    expect(coupables).toEqual([]);
  });

  it('et le predicat multicast n\'est pas recopie dans devices/', () => {
    const copie = /first\s*>=\s*224\s*&&\s*first\s*<=\s*239/;
    const coupables = fichiersTs('src/network/devices')
      .filter((f) => copie.test(readFileSync(f, 'utf8')));
    expect(coupables).toEqual([]);
  });
});
