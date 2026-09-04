import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface IpGlobalFlags {
  ipClassless: boolean;
  ipSubnetZero: boolean;
}

export interface IpGlobalHost {
  setIpRouting(on: boolean): void;
  flags(): IpGlobalFlags;
}

const MODES = ['config'] as const;

export const IPV4_PLACE: ArgumentSpec = {
  name: 'address', type: 'IP_ADDR', description: 'IP address',
};

/**
 * Les interrupteurs IP GLOBAUX, declares une fois pour les deux
 * plateformes Cisco.
 *
 * Ils etaient enregistres deux fois, une par coquille, et c'est
 * exactement le lieu ou une divergence ne se voit pas : mesure sur les
 * deux machines, `ip classless` et `ip subnet-zero` sont ACCEPTES sur un
 * routeur et REFUSES sur un Catalyst, alors que le guide de
 * configuration du Catalyst 3560 documente les deux — la meme frappe
 * recevait deux reponses selon la machine, et rien ne pouvait le dire
 * puisque les deux vocabulaires vivaient chacun de son cote. Le socle
 * est partage par les deux coquilles ; le trie ne l'est pas, et c'est
 * la raison de fond de migrer une famille commune en premier.
 *
 * `no ip classless` et `no ip subnet-zero` etaient de surcroit acceptes
 * et ranges NULLE PART, comme leur forme positive. Pour la positive
 * c'est juste — c'est le defaut d'IOS depuis la 12.0, et une machine ne
 * rend pas ce dont elle ne s'ecarte pas ; pour la NEGATIVE c'est un
 * reglage perdu, et la configuration rendue etant rejouee a l'import
 * d'une topologie, la coupure disparaissait au rechargement. Le drapeau
 * vit dans `CiscoSecurityConfig`, a cote de `ipCef` et `ipSourceRoute`
 * qui sont le meme genre de fait et que les DEUX plateformes rendent
 * deja.
 */
/**
 * Un reglage global qui prend UNE valeur, et dont le `no` l'accepte ou
 * s'en passe.
 *
 * Les trois de cette forme — `ip default-network`, `ip default-gateway`,
 * `ip local policy route-map` — prenaient toutes le mot de trop en
 * silence : `ip default-network 10.0.0.0 zorglub` etait accepte, et `ip
 * local policy route-map A B` gardait `A` sans dire ce qu'il faisait de
 * `B`. Une place declaree les refuse par construction, et les deux
 * formes du `no` — avec et sans la valeur — restent acceptees parce que
 * les deux l'etaient.
 */
export function valeurGlobaleSpecs(
  id: string, mots: readonly string[], description: string,
  place: ArgumentSpec, poser: (valeur: string | null) => void,
): CommandSpec[] {
  return [
    {
      id,
      path: [...mots, place],
      description,
      undoDescription: `Remove ${description.toLowerCase()}`,
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => { poser(args[place.name]); return ''; },
      undo: () => { poser(null); return ''; },
    },
    {
      id: `${id}-no`,
      path: [...mots],
      description,
      undoDescription: `Remove ${description.toLowerCase()}`,
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { poser(null); return ''; },
    },
  ];
}

export function ipGlobalSpecs(ctx: () => IpGlobalHost): CommandSpec[] {
  const bascule = (
    id: string, mot: string, description: string,
    lire: (flags: IpGlobalFlags, on: boolean) => void,
  ): CommandSpec => ({
    id,
    path: ['ip', mot],
    description,
    undoDescription: `Disable ${description.toLowerCase()}`,
    modes: MODES, minPrivilege: 15,
    run: () => { lire(ctx().flags(), true); return ''; },
    undo: () => { lire(ctx().flags(), false); return ''; },
  });

  return [
    {
      id: 'ip-routing',
      path: ['ip', 'routing'],
      description: 'Enable IP routing',
      undoDescription: 'Disable IP routing',
      modes: MODES, minPrivilege: 15,
      run: () => { ctx().setIpRouting(true); return ''; },
      undo: () => { ctx().setIpRouting(false); return ''; },
    },
    bascule('ip-classless', 'classless',
      'Follow classless routing forwarding rules',
      (flags, on) => { flags.ipClassless = on; }),
    bascule('ip-subnet-zero', 'subnet-zero',
      'Enable use of subnet zero',
      (flags, on) => { flags.ipSubnetZero = on; }),
  ];
}
