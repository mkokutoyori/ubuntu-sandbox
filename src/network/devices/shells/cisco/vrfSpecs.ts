import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import {
  ensureVrf, isVrfName, vrfStoreOf, VRF_NAME_MAX,
  type VrfHost, type VrfSpelling,
} from './ciscoVrfStore';

const CONFIG = ['config'] as const;

const NOM: ArgumentSpec = {
  name: 'nom', type: 'WORD',
  description: 'VPN Routing/Forwarding instance name',
};

export interface VrfDeclarationHost {
  vrfHost(): VrfHost;
  selectVrf(name: string): void;
  enterVrfMode(): void;
  /** Ce que la suppression d'une VRF doit encore nettoyer, s'il y a lieu. */
  onVrfRemoved?(name: string): void;
}

/**
 * `ip vrf` et `vrf definition` declarent la MEME instance, et ce sont
 * deux orthographes de la meme commande — l'heritee, IPv4 seule, et la
 * multiprotocole. Le magasin retient laquelle a servi, parce que la
 * configuration rendue est rejouee a l'import d'une topologie et qu'une
 * forme reecrite en l'autre changerait ce que l'operateur a ecrit.
 *
 * Trois defauts mesures que la declaration ferme. `ip vrf` etait
 * enregistree par la famille NAT, donc ROUTEUR SEUL : la meme frappe
 * etait acceptee sur un routeur et refusee sur un Catalyst, alors que
 * VRF-lite est justement une fonction de commutateur. `vrf` tout court
 * etait un noeud GLOUTON qui rangeait la ligne et rendait la main sans
 * un mot — `vrf`, `vrf zorglub`, `vrf forwarding X` en configuration
 * globale etaient tous acceptes, ranges et rendus dans la
 * configuration, donc rejoues a l'import. Et `vrf definition NOM
 * zorglub` avalait le mot de trop.
 */
export function vrfDeclarationSpecs(
  ctx: () => VrfDeclarationHost,
): CommandSpec[] {
  const declarer = (
    id: string, mots: readonly string[], spelling: VrfSpelling,
    description: string,
  ): CommandSpec => ({
    id,
    path: [...mots, NOM],
    description,
    undoDescription: `Remove ${description.toLowerCase()}`,
    modes: CONFIG, minPrivilege: 15,
    run: (_session, args) => {
      if (!isVrfName(args.nom)) {
        return `% VRF name is limited to ${VRF_NAME_MAX} characters`;
      }
      const host = ctx();
      ensureVrf(vrfStoreOf(host.vrfHost()), args.nom, spelling);
      host.selectVrf(args.nom);
      host.enterVrfMode();
      return '';
    },
    undo: (_session, args) => {
      const host = ctx();
      vrfStoreOf(host.vrfHost()).delete(args.nom);
      host.onVrfRemoved?.(args.nom);
      return '';
    },
  });

  return [
    declarer('ip-vrf', ['ip', 'vrf'], 'legacy', 'Define a VRF instance'),
    declarer('vrf-definition', ['vrf', 'definition'], 'modern',
      'Configure a VRF'),
  ];
}

export interface VrfInterfaceHost {
  vrfHost(): VrfHost;
  selectedInterface(): string | undefined;
  interfaceVrfTable(): Map<string, string>;
  /** L'adresse que porte cette interface, s'il y en a une, et son retrait. */
  interfaceAddress(iface: string): string | undefined;
  unconfigureInterface(iface: string): void;
}

/**
 * `ip vrf forwarding` et `vrf forwarding` rattachent une interface, et
 * ce sont les deux orthographes de la meme chose.
 *
 * Seule l'HERITEE etait declaree ; la moderne tombait dans le glouton
 * `vrf` de la configuration globale, donc elle etait acceptee, rangee,
 * rendue dans la configuration — et l'interface n'etait rattachee a
 * RIEN. C'est le pire des trois etats : la configuration decrit une
 * isolation que le plan de donnees n'applique pas.
 *
 * La forme nue (`no vrf forwarding`, sans nom) existe parce qu'IOS
 * l'accepte : on detache une interface sans avoir a renommer la VRF
 * dont on veut la sortir.
 */
export function vrfInterfaceSpecs(
  ctx: () => VrfInterfaceHost, modes: readonly string[],
): CommandSpec[] {
  const detacher = (iface: string): void => {
    const host = ctx();
    const table = host.interfaceVrfTable();
    const lie = table.get(iface);
    if (lie === undefined) return;
    vrfStoreOf(host.vrfHost()).get(lie)?.interfaces.delete(iface);
    table.delete(iface);
  };

  const rattacher = (cible: string): string => {
    const host = ctx();
    const iface = host.selectedInterface();
    if (!iface) return '% No interface selected.';
    const store = vrfStoreOf(host.vrfHost());
    if (!store.has(cible)) return `% VRF ${cible} not configured`;
    detacher(iface);
    store.get(cible)!.interfaces.add(iface);
    host.interfaceVrfTable().set(iface, cible);
    const adresse = host.interfaceAddress(iface);
    if (!adresse) return '';
    host.unconfigureInterface(iface);
    return `% Interface ${iface} IP address ${adresse} `
      + `removed due to enabling VRF ${cible}`;
  };

  const oter = (): string => {
    const iface = ctx().selectedInterface();
    if (!iface) return '% No interface selected.';
    detacher(iface);
    return '';
  };

  const paire = (id: string, mots: readonly string[]): CommandSpec[] => [
    {
      id,
      path: [...mots, { ...NOM, name: 'vrf' }],
      description: 'Configure forwarding table',
      undoDescription: 'Remove the interface from its forwarding table',
      modes, minPrivilege: 15,
      run: (_session, args) => rattacher(args.vrf ?? ''),
      undo: () => oter(),
    },
    {
      id: `${id}-nu`,
      path: [...mots],
      description: 'Configure forwarding table',
      undoDescription: 'Remove the interface from its forwarding table',
      existsOnlyNegated: true,
      modes, minPrivilege: 15,
      run: () => '% Incomplete command.',
      undo: () => oter(),
    },
  ];

  return [
    ...paire('config-if-ip-vrf-forwarding', ['ip', 'vrf', 'forwarding']),
    ...paire('config-if-vrf-forwarding', ['vrf', 'forwarding']),
  ];
}
