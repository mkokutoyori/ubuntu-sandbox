/**
 * LinkState — l'état d'un lien tel que systemd-networkd le voit.
 *
 * Toujours dérivé, jamais mémorisé : un état stocké peut diverger du lien
 * qu'il décrit, et c'est exactement le défaut que ce modèle corrige
 * (`docs/PRD-networkctl.md` §2.1). La source de vérité reste le `Port`,
 * la même que celle de `ip link` — deux commandes qui lisent le même bit
 * ne peuvent pas se contredire.
 */

import type { LinuxNetKernel } from '../LinuxNetKernel';
import type { NetplanConfig } from './NetworkConfigFiles';

/** `networkctl(1)`, par ordre croissant de disponibilité. */
export type OperationalState =
  | 'missing'
  | 'off'
  | 'no-carrier'
  | 'dormant'
  | 'degraded-carrier'
  | 'carrier'
  | 'degraded'
  | 'enslaved'
  | 'routable';

export type SetupState =
  | 'pending'
  | 'initialized'
  | 'configuring'
  | 'configured'
  | 'unmanaged'
  | 'failed'
  | 'linger';

export type OnlineState = 'offline' | 'partial' | 'online';

export type AddressSource =
  | 'static'
  | 'DHCPv4'
  | 'DHCPv6'
  | 'RA'
  | 'link-local'
  | 'foreign';

export interface LinkState {
  index: number;
  name: string;
  type: 'loopback' | 'ether';
  operational: OperationalState;
  setup: SetupState;
  online: Exclude<OnlineState, 'partial'>;
  addressSource: AddressSource | null;
  hardwareAddress: string | null;
  mtu: number;
  /** Adresses en notation CIDR, IPv4 puis IPv6. */
  addresses: string[];
  gateway: string | null;
  dns: string[];
  networkFile: string | null;
  linkFile: string | null;
  managedByNetworkManager: boolean;
}

export interface LinkStateDeps {
  net: LinuxNetKernel;
  netplan: NetplanConfig | null;
  isManagedByNetworkManager(iface: string): boolean;
  /** Contenu de `/etc/resolv.conf`, ou null s'il est absent. */
  resolvConf: string | null;
  /** Fichiers `.network`/`.link` qui s'appliquent au lien (phase 3). */
  resolveFiles?(iface: string): { networkFile: string | null; linkFile: string | null };
}

export const LOOPBACK_MTU = 65536;

/**
 * Un lien est « en ligne » à partir de `degraded` : c'est le seuil par
 * défaut de `RequiredForOnline=` chez systemd, une adresse lien-local
 * suffisant à considérer la configuration aboutie.
 */
export function isOnline(operational: OperationalState): boolean {
  return operational === 'routable' || operational === 'degraded' || operational === 'enslaved';
}

function parseResolvConf(text: string | null): string[] {
  if (!text) return [];
  return [...text.matchAll(/^\s*nameserver\s+(\S+)/gim)].map((m) => m[1]);
}

function maskToPrefix(mask: string): number {
  return mask.split('.')
    .map((o) => (Number(o) >>> 0).toString(2).split('1').length - 1)
    .reduce((a, b) => a + b, 0);
}

function loopbackState(index: number): LinkState {
  return {
    index,
    name: 'lo',
    type: 'loopback',
    // La boucle locale porte toujours, et aucun `.network` ne la réclame :
    // c'est ce que rend le vrai networkd.
    operational: 'carrier',
    setup: 'unmanaged',
    online: 'offline',
    addressSource: 'static',
    hardwareAddress: '00:00:00:00:00:00',
    mtu: LOOPBACK_MTU,
    addresses: ['127.0.0.1/8', '::1/128'],
    gateway: null,
    dns: [],
    networkFile: null,
    linkFile: null,
    managedByNetworkManager: false,
  };
}

function deriveOperational(deps: LinkStateDeps, name: string): OperationalState {
  const port = deps.net.getPorts().get(name);
  if (!port) return 'missing';
  if (!port.getIsUp()) return 'off';
  if (!port.isConnected()) return 'no-carrier';

  const hasV4 = port.getIPAddress() !== null;
  const v6 = port.getIPv6Addresses();
  if (hasV4 || v6.some((e) => e.origin !== 'link-local')) return 'routable';
  if (v6.length > 0) return 'degraded';
  return 'carrier';
}

/**
 * `configured` veut dire que networkd a fini, pas seulement qu'il a
 * essayé : une interface déclarée en DHCP sans bail reste `configuring`,
 * ce qui est précisément l'état d'un lien qui attend une porteuse.
 */
function deriveSetup(deps: LinkStateDeps, name: string): SetupState {
  if (deps.isManagedByNetworkManager(name)) return 'unmanaged';
  if (deps.netplan?.renderer === 'NetworkManager') return 'unmanaged';
  const declared = deps.netplan?.interfaces.get(name);
  if (!declared) return 'unmanaged';
  if (declared.method !== 'dhcp') return 'configured';
  return hasActiveLease(deps, name) ? 'configured' : 'configuring';
}

function hasActiveLease(deps: LinkStateDeps, name: string): boolean {
  const state = deps.net.getDhcpClient().getState(name);
  return state?.lease != null && (state.state === 'BOUND' || state.state === 'RENEWING' || state.state === 'REBINDING');
}

/**
 * Constatée sur le lien vivant, pas lue dans le fichier déclaré : une
 * interface déclarée en DHCP mais portant une adresse posée à la main
 * est statique, quoi qu'en dise le YAML.
 */
function deriveAddressSource(deps: LinkStateDeps, name: string): AddressSource | null {
  const port = deps.net.getPorts().get(name);
  if (!port) return null;
  if (hasActiveLease(deps, name)) return 'DHCPv4';
  if (port.getIPAddress() !== null) return 'static';
  const v6 = port.getIPv6Addresses();
  if (v6.length === 0) return null;
  const best = v6.find((e) => e.origin !== 'link-local') ?? v6[0];
  if (best.origin === 'dhcpv6') return 'DHCPv6';
  if (best.origin === 'slaac') return 'RA';
  if (best.origin === 'link-local') return 'link-local';
  return 'static';
}

function linkAddresses(deps: LinkStateDeps, name: string): string[] {
  const port = deps.net.getPorts().get(name);
  if (!port) return [];
  const out: string[] = [];
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  if (ip && mask) out.push(`${ip.toString()}/${maskToPrefix(mask.toString())}`);
  for (const entry of port.getIPv6Addresses()) {
    // La zone (`%eth0`) appartient au socket, pas à l'adresse : ni
    // `ip addr` ni `networkctl` ne l'impriment ici.
    out.push(`${entry.address.toString().split('%')[0]}/${entry.prefixLength}`);
  }
  return out;
}

export function deriveLinkState(deps: LinkStateDeps, name: string): LinkState | null {
  if (name === 'lo') return loopbackState(deps.net.getIfIndex('lo'));
  const port = deps.net.getPorts().get(name);
  if (!port) return null;

  const operational = deriveOperational(deps, name);
  const files = deps.resolveFiles?.(name) ?? { networkFile: null, linkFile: null };
  const lease = deps.net.getDhcpClient().getState(name)?.lease ?? null;
  const dns = lease?.dnsServers?.length ? [...lease.dnsServers] : parseResolvConf(deps.resolvConf);
  const gateway = lease?.defaultGateway ?? deps.net.getDefaultGateway()?.toString() ?? null;

  return {
    index: deps.net.getIfIndex(name),
    name,
    type: 'ether',
    operational,
    setup: deriveSetup(deps, name),
    online: isOnline(operational) ? 'online' : 'offline',
    addressSource: deriveAddressSource(deps, name),
    hardwareAddress: port.getMAC().toString(),
    mtu: port.getMTU(),
    addresses: linkAddresses(deps, name),
    gateway,
    dns,
    networkFile: files.networkFile,
    linkFile: files.linkFile,
    managedByNetworkManager: deps.isManagedByNetworkManager(name),
  };
}

/** Tous les liens, `lo` en tête — même convention que `ip link`. */
export function deriveLinkStates(deps: LinkStateDeps): LinkState[] {
  const names = ['lo', ...[...deps.net.getPorts().keys()].filter((n) => n !== 'lo')];
  const out: LinkState[] = [];
  for (const name of names) {
    const state = deriveLinkState(deps, name);
    if (state) out.push(state);
  }
  return out;
}

/** État en ligne agrégé du gestionnaire, sur les seuls liens qu'il gère. */
export function aggregateOnlineState(links: readonly LinkState[]): OnlineState {
  const managed = links.filter((l) => l.setup !== 'unmanaged');
  if (managed.length === 0) return 'offline';
  const online = managed.filter((l) => l.online === 'online').length;
  if (online === 0) return 'offline';
  return online === managed.length ? 'online' : 'partial';
}

/** État opérationnel agrégé : celui du lien géré le mieux portant. */
export function aggregateOperationalState(links: readonly LinkState[]): OperationalState {
  const ORDER: OperationalState[] = [
    'missing', 'off', 'no-carrier', 'dormant', 'degraded-carrier',
    'carrier', 'degraded', 'enslaved', 'routable',
  ];
  const managed = links.filter((l) => l.setup !== 'unmanaged');
  if (managed.length === 0) return 'off';
  return managed.reduce<OperationalState>(
    (best, l) => (ORDER.indexOf(l.operational) > ORDER.indexOf(best) ? l.operational : best),
    'missing',
  );
}

/** Motif glob de `networkctl list PATTERN…` (`*` et `?` seulement). */
export function matchesPattern(name: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => {
    const rx = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    return rx.test(name);
  });
}
