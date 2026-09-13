import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface Ipv6PorteHost {
  ouvrirListe(nom: string): string;
  ouvrirEigrp(asn: string): string;
  ouvrirOspf(processus: string): string;
  poserRoute(mots: readonly string[]): string;
}

const CONFIG = Object.freeze(['config']);

const NOM_DE_LISTE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Name of the IPv6 access list',
};

const ASN: ArgumentSpec = {
  name: 'asn', type: 'INT', range: [1, 65535],
  description: 'Autonomous system number',
};

/**
 * L'identifiant de processus OSPFv3, ANNONCE mais pas juge ici.
 *
 * Le gestionnaire refuse deja avec les mots de la plateforme —
 * « % Invalid OSPFv3 process ID » — et c'est le refus le plus precis des
 * deux. La plage est donc declaree pour que `?` la nomme, et marquee
 * comme DECRIVANT sans trancher : deux refus pour une seule saisie
 * seraient un refus de trop.
 */
const PROCESSUS_OSPF: ArgumentSpec = {
  name: 'processus', type: 'INT', range: [1, 65535], rangeIsAdvisory: true,
  description: 'Process ID of the OSPFv3 instance',
};

const PREFIXE: ArgumentSpec = {
  name: 'prefixe', type: 'IPV6_PREFIX', description: 'IPv6 prefix and length',
};

/**
 * La destination de la route : une adresse, ou une interface de sortie
 * suivie au besoin de l'adresse du voisin.
 *
 * Le gestionnaire lit les deux formes et accepte un troisieme mot apres
 * l'interface, donc la place est un RESTE — mais un reste qui EXIGE son
 * premier mot, sans quoi `ipv6 route <prefixe>` passait pour complete.
 */
const SORTIE: ArgumentSpec = {
  name: 'sortie', type: 'REST', literal: 'LINE', restMinWords: 1,
  description: 'Next-hop address, or egress interface then its next hop',
};

export function ipv6PorteSpecs(ctx: () => Ipv6PorteHost): CommandSpec[] {
  return [
    {
      id: 'ipv6-access-list',
      path: ['ipv6', 'access-list', NOM_DE_LISTE],
      description: 'Define an IPv6 named access list',
      modes: CONFIG, minPrivilege: 15,
      enters: 'config-ipv6-nacl',
      run: (_s, args) => ctx().ouvrirListe(args.nom),
    },
    {
      id: 'ipv6-router-eigrp',
      path: ['ipv6', 'router', 'eigrp', ASN],
      description: 'Configure EIGRP for IPv6',
      modes: CONFIG, minPrivilege: 15,
      enters: 'config-router',
      run: (_s, args) => ctx().ouvrirEigrp(args.asn),
    },
    /*
     * L'identifiant est EXIGE. Il valait « 1 » quand on l'omettait, donc
     * une frappe incomplete creait un processus OSPFv3 que personne
     * n'avait demande, et l'operateur se retrouvait dans son sous-mode a
     * configurer un processus qu'il n'a pas nomme.
     */
    {
      id: 'ipv6-router-ospf',
      path: ['ipv6', 'router', 'ospf', PROCESSUS_OSPF],
      description: 'Configure OSPFv3',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => ctx().ouvrirOspf(args.processus),
    },
    {
      id: 'ipv6-route',
      path: ['ipv6', 'route', PREFIXE, SORTIE],
      description: 'Configure an IPv6 static route',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) =>
        ctx().poserRoute([args.prefixe, ...args.sortie.split(/\s+/).filter(Boolean)]),
    },
  ];
}
