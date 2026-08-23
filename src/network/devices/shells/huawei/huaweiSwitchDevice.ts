/**
 * PRD-CLI-Fidelite-VRP.md §19 / lot V10 — ce que le shell EXIGE de son
 * equipement, ecrit une fois.
 *
 * `HuaweiSwitchShell.ts` ne portait qu'un seul `no-explicit-any` mais
 * **37 `as unknown as`**, qui eteignent le compilateur de la meme facon
 * sans couter une ligne de lint. Quatorze d'entre eux redeclaraient le
 * MEME accesseur d'agent, chacun avec son `import(...)` en ligne.
 *
 * Le cast etait legitime dans son principe : `swRef` est un `Switch`, et
 * ces agents vivent sur `HuaweiSwitch` — un `GenericSwitch` n'en a
 * aucun, ce que `CLAUDE.md` documente. Ce qui ne l'etait pas, c'est de
 * l'affirmer quatorze fois : chaque site pouvait ecrire une signature
 * differente de celle du voisin sans que rien ne le signale.
 *
 * Les membres sont OPTIONNELS parce qu'ils le sont reellement : un
 * `GenericSwitch` n'en porte aucun.
 */

import type { Switch, VLANEntry } from '../../Switch';
import type { Router } from '../../Router';
import type { StpAgent } from '@/network/stp/StpAgent';
import type { LldpAgent } from '@/network/lldp/LldpAgent';
import type { LacpAgent } from '@/network/lacp/LacpAgent';
import type { Dot1xAgent } from '@/network/dot1x/Dot1xAgent';
import type { IgmpSnoopingAgent } from '@/network/igmp-snooping/IgmpSnoopingAgent';
import type { PimSnoopingAgent } from '@/network/pim-snooping/PimSnoopingAgent';
import type { NATEngine } from '../../router/NATEngine';
import type { HuaweiDebugService } from '../../router/diag/HuaweiDebugService';

export interface HuaweiSwitchDevice extends Switch {
  getStpAgent?(): StpAgent;
  getManagementService?(): import('../../router/management/RouterManagementService').RouterManagementService;
  getSnmpService?(): import('../../router/management/SnmpService').SnmpService;
  getLldpAgent?(): LldpAgent;
  getLacpAgent?(): LacpAgent;
  getDot1xAgent?(): Dot1xAgent;
  getIgmpSnoopingAgent?(): IgmpSnoopingAgent;
  getPimSnoopingAgent?(): PimSnoopingAgent;
  _getNATEngine?(): NATEngine;
  getHuaweiDebugService?(): HuaweiDebugService;
  getPortGroups?(): [string, string[]][];
  getPortGroupMembers?(name: string): string[] | null;
  createPortGroup?(name: string): boolean;
  deletePortGroup?(name: string): boolean;
  addPortGroupMembers?(name: string, ports: readonly string[]): 'ok' | 'absent' | 'plein';
  removePortGroupMembers?(name: string, ports: readonly string[]): boolean;
  addVoiceVlanOui?(macHex: string, maskHex: string, description?: string): void;
}

/**
 * Les aides Huawei partagees (NAT, DHCP, ACL) sont typees contre
 * `Router`, et le switch les reutilise telles quelles. La conversion est
 * faite ICI, une fois, plutot qu'a sept endroits : elle tient parce que
 * `HuaweiSwitch` porte les membres que ces aides touchent
 * (`_getNATEngine`, la table d'interfaces), et le jour ou un switch sans
 * moteur NAT recevra ce shell, c'est cette fonction qui aura a le dire —
 * pas sept sites qui l'ignorent chacun de leur cote.
 */
export function commeRouteur(sw: Switch | null): Router {
  return sw as unknown as Router;
}

/** Le moteur NAT quand la plateforme en a un — `GenericSwitch` n'en a pas. */
export function moteurNat(sw: HuaweiSwitchDevice | null): NATEngine | null {
  return sw?._getNATEngine?.() ?? null;
}

/**
 * Les lignes de vue VLAN que `VLANEntry` ne declare pas —
 * `igmp-snooping`, `mux-vlan`, `vlan-type`, `mac-vlan`, `ip`, `arp`.
 *
 * Elles etaient rangees par `(v as unknown as { extras }).extras` a six
 * endroits, et **lues par personne** : la configuration d'un VLAN les
 * perdait donc au rendu, et une topologie rechargee ne les avait plus.
 * Le magasin est declare ici (une conversion au lieu de six) et il est
 * desormais RENDU, ce qui etait sa seule raison d'exister.
 */
export type VlanExtras = VLANEntry & { extras?: Record<string, string[]> };

export function ajouterLigneVlan(v: VLANEntry, cle: string, ligne: string): void {
  const cible = v as VlanExtras;
  const extras = cible.extras ?? (cible.extras = {});
  (extras[cle] ??= []).push(ligne);
}

export function lignesDuVlan(v: VLANEntry): readonly string[] {
  const extras = (v as VlanExtras).extras;
  return extras ? Object.values(extras).flat() : [];
}
