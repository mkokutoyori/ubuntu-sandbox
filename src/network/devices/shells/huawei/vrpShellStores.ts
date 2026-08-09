/**
 * Les magasins que le shell VRP accroche au `Router`, déclarés une fois.
 *
 * `HuaweiVRPShell` range huit choses sur l'objet routeur — pare-feu,
 * plages horaires, politiques CPU-defend, LLDP, profils de file, extras
 * RIP/IS-IS/QoS par interface — sous des propriétés `_huawei*` que
 * `Router` ne déclare pas. Chaque accès s'écrivait donc
 * `const r = this.r() as any;`, trente et une fois dans le fichier, et
 * `as any` ne coûte pas seulement une erreur de lint : il éteint le
 * compilateur sur TOUT ce qui suit le point. Une faute de frappe sur
 * `_huaweiLdp`, un `cfg.enabled` devenu `cfg.enable`, un `.get()` sur
 * une valeur absente : rien de tout cela n'était vu.
 *
 * Un seul endroit fait la conversion, et il rend une forme DÉCLARÉE.
 * C'est ce que `CLAUDE.md` demande depuis l'audit 08 (« préférer
 * étendre ces interfaces à un `dev as unknown as { … }` neuf sur le site
 * d'appel ») ; ici la forme n'existait simplement nulle part.
 *
 * Les noms de propriétés sont conservés à l'identique : ce sont des
 * champs vivants sur des objets déjà construits, et les renommer serait
 * un changement de comportement déguisé en typage.
 */

import type { Router } from '../../Router';

/** `firewall enable` / `firewall defend <kind> enable`. */
export interface VrpFirewallState {
  enabled: boolean;
  defenses: Set<string>;
}

/** `time-range <nom> …` — le nom et la ligne telle qu'elle a été tapée. */
export interface VrpTimeRange {
  name: string;
  spec: string;
}

/** Une entrée nommée qui ne garde que ses lignes brutes. */
export interface VrpNamedLines {
  name: string;
  lines: string[];
}

/** `lldp enable` / `lldp management-address <ip>` au niveau global. */
export interface VrpLldpConfig {
  enabled: boolean;
  mgmtAddress: string | null;
  lines: string[];
}

/**
 * Les magasins par interface sont tous la même chose : un attribut
 * nommé vers la ligne qui l'a produit. C'est cette uniformité qui
 * permettait le `r[bucket]` dynamique, et qui la rend typable.
 */
export type VrpInterfaceAttrs = Record<string, string>;

/**
 * Ce que le shell VRP ajoute au routeur. Tout est optionnel : chaque
 * magasin naît à la première commande qui l'écrit, et son absence est
 * l'état normal d'un routeur qu'on vient de poser.
 */
export interface VrpRouterStores {
  _huaweiFirewall?: VrpFirewallState;
  _huaweiTimeRanges?: Map<string, VrpTimeRange>;
  _huaweiCpuDefendPolicies?: Map<string, VrpNamedLines>;
  _huaweiCpuDefendCurrent?: string;
  _huaweiCpuDefendGlobal?: string;
  _huaweiCpuDefendLines?: string[];
  _huaweiLldp?: VrpLldpConfig;
  _huaweiQueueProfiles?: Map<string, VrpNamedLines>;
  _huaweiRipIfExtras?: Map<string, VrpInterfaceAttrs>;
  _huaweiIsisIfExtras?: Map<string, VrpInterfaceAttrs>;
  _huaweiQosIf?: Map<string, VrpInterfaceAttrs>;
  _huaweiLldpIf?: Map<string, VrpInterfaceAttrs>;
  _huaweiSflowIf?: Map<string, VrpInterfaceAttrs>;
}

/**
 * Les seules propriétés que `ifAttr(bucket)` accepte comme seau.
 *
 * Le code faisait `r[bucket]` avec un `bucket: string`, ce qu'aucun
 * type ne peut vérifier : `ifAttr('_huaweiLdpIf')` aurait créé un
 * neuvième magasin, silencieusement, que rien n'aurait jamais lu.
 * Restreindre le paramètre aux clés réelles fait de cette faute une
 * erreur de compilation.
 */
export type VrpInterfaceBucket =
  | '_huaweiLldpIf' | '_huaweiSflowIf' | '_huaweiRipIfExtras'
  | '_huaweiIsisIfExtras' | '_huaweiQosIf';

/** L'unique conversion, pour que les trente autres n'existent plus. */
export function vrpStores(router: Router): VrpRouterStores {
  return router as unknown as VrpRouterStores;
}

/**
 * Le magasin par interface demandé, créé à la volée.
 *
 * Ce couple création-si-absent était recopié à cinq endroits, chaque
 * fois avec son propre `?? (r.x = new Map())` ; une seule copie ne peut
 * pas se tromper de seau au milieu.
 */
export function vrpInterfaceStore(
  router: Router,
  bucket: VrpInterfaceBucket,
): Map<string, VrpInterfaceAttrs> {
  const r = vrpStores(router);
  const existant = r[bucket];
  if (existant) return existant;
  const frais = new Map<string, VrpInterfaceAttrs>();
  r[bucket] = frais;
  return frais;
}

/** Pose `key` sur l'interface `ifName` du seau demandé. */
export function vrpSetInterfaceAttr(
  router: Router,
  bucket: VrpInterfaceBucket,
  ifName: string,
  key: string,
  value: string,
): void {
  const store = vrpInterfaceStore(router, bucket);
  const entry = store.get(ifName) ?? {};
  entry[key] = value;
  store.set(ifName, entry);
}
