/**
 * NetworkdPlan — ce qu'un lien doit devenir, résolu depuis les fichiers.
 *
 * L'analyseur de `.network`/`.link`/`.netdev` existait déjà mais personne
 * ne le consommait : le démon lisait sa configuration sans rien en faire
 * (`docs/PRD-networkd.md` §1.3). Ce module est le plan que le démon
 * applique, distinct de `LinkState` qui n'est qu'une lecture.
 *
 * Règle d'unicité : un lien est gouverné par UN seul `.network`, le
 * premier retenu dans l'ordre lexicographique. systemd ne fusionne pas
 * plusieurs fichiers pour un même lien, et le faire ici inventerait une
 * sémantique.
 */

import type { VirtualFileSystem } from '../VirtualFileSystem';
import {
  discoverNetworkdFiles,
  getAll,
  get,
  matchLinkFile,
  matchNetworkFile,
  type NetworkdFile,
} from './NetworkdFiles';

export type DhcpMode = 'no' | 'yes' | 'ipv4' | 'ipv6';
export type ActivationPolicy = 'up' | 'always-up' | 'manual' | 'down' | 'always-down';

export interface PlannedRoute {
  destination: string;
  gateway: string | null;
  metric: number | null;
}

export interface NetworkdLinkPlan {
  iface: string;
  /** Adresses en CIDR, dans l'ordre du fichier. */
  addresses: string[];
  gateway: string | null;
  routes: PlannedRoute[];
  dns: string[];
  domains: string[];
  dhcp: DhcpMode;
  mtu: number | null;
  macAddress: string | null;
  activationPolicy: ActivationPolicy;
  /** `[DHCPv4] UseDNS=`, `UseRoutes=`, `UseMTU=` — défaut `true` chez systemd. */
  useDns: boolean;
  useRoutes: boolean;
  useMtu: boolean;
  /** Le `.network` qui gouverne ce lien. */
  networkFile: string;
  /** Le `.link` retenu, s'il y en a un. */
  linkFile: string | null;
}

export interface PlannedNetdev {
  name: string;
  kind: string;
  /** `[VLAN] Id=` — seulement pour `Kind=vlan`. */
  vlanId: number | null;
  path: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|yes|true|on)$/i.test(value.trim());
}

function parseDhcp(value: string | undefined): DhcpMode {
  const v = (value ?? 'no').trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') return 'yes';
  if (v === 'ipv4') return 'ipv4';
  if (v === 'ipv6') return 'ipv6';
  return 'no';
}

function parseActivationPolicy(value: string | undefined): ActivationPolicy {
  const v = (value ?? 'up').trim().toLowerCase();
  if (v === 'always-up' || v === 'manual' || v === 'down' || v === 'always-down') return v;
  return 'up';
}

/**
 * `DNS=` accepte plusieurs serveurs sur une même ligne autant que
 * plusieurs lignes ; systemd concatène les deux formes.
 */
function splitList(values: readonly string[]): string[] {
  return values.flatMap((v) => v.split(/[\s,]+/).filter(Boolean));
}

function collectRoutes(file: NetworkdFile): PlannedRoute[] {
  // `[Route]` peut apparaître plusieurs fois ; l'analyseur fusionne les
  // sections de même nom, donc les clés arrivent en tableaux parallèles.
  const dests = getAll(file, 'Route', 'Destination');
  const gws = getAll(file, 'Route', 'Gateway');
  const metrics = getAll(file, 'Route', 'Metric');
  const out: PlannedRoute[] = [];
  const count = Math.max(dests.length, gws.length);
  for (let i = 0; i < count; i++) {
    const destination = dests[i] ?? '0.0.0.0/0';
    const gateway = gws[i] ?? null;
    const metric = metrics[i] !== undefined ? Number(metrics[i]) : null;
    out.push({ destination, gateway, metric: Number.isFinite(metric) ? metric : null });
  }
  return out;
}

function buildPlan(iface: string, network: NetworkdFile, link: NetworkdFile | null): NetworkdLinkPlan {
  const addresses = [
    ...splitList(getAll(network, 'Network', 'Address')),
    ...splitList(getAll(network, 'Address', 'Address')),
  ];
  const routes = collectRoutes(network);
  // Une `[Route]` sans destination avec passerelle est la route par
  // défaut : c'est la forme longue de `[Network] Gateway=`.
  const defaultFromRoute = routes.find(
    (r) => r.destination === '0.0.0.0/0' || r.destination === 'default');
  const gateway = get(network, 'Network', 'Gateway') ?? defaultFromRoute?.gateway ?? null;

  // `[Link]` d'un .link a la priorité sur celui du .network : c'est le
  // fichier dédié aux propriétés du périphérique.
  const mtuRaw = get(link ?? network, 'Link', 'MTUBytes') ?? get(network, 'Link', 'MTUBytes');
  const mtu = mtuRaw !== undefined ? Number(mtuRaw) : null;
  const macAddress = get(link ?? network, 'Link', 'MACAddress')
    ?? get(network, 'Link', 'MACAddress') ?? null;

  return {
    iface,
    addresses,
    gateway,
    routes: routes.filter((r) => r !== defaultFromRoute),
    dns: splitList(getAll(network, 'Network', 'DNS')),
    domains: splitList(getAll(network, 'Network', 'Domains')),
    dhcp: parseDhcp(get(network, 'Network', 'DHCP')),
    mtu: Number.isFinite(mtu) && mtu! > 0 ? mtu : null,
    macAddress,
    activationPolicy: parseActivationPolicy(get(network, 'Link', 'ActivationPolicy')),
    useDns: bool(get(network, 'DHCPv4', 'UseDNS'), true),
    useRoutes: bool(get(network, 'DHCPv4', 'UseRoutes'), true),
    useMtu: bool(get(network, 'DHCPv4', 'UseMTU'), true),
    networkFile: network.path,
    linkFile: link?.path ?? null,
  };
}

/** Le plan de chaque lien qu'un `.network` réclame. */
export function resolveNetworkdPlans(
  vfs: VirtualFileSystem,
  ifaceNames: readonly string[],
): Map<string, NetworkdLinkPlan> {
  const files = discoverNetworkdFiles(vfs);
  const plans = new Map<string, NetworkdLinkPlan>();
  for (const iface of ifaceNames) {
    const network = matchNetworkFile(files, iface);
    if (!network) continue;
    plans.set(iface, buildPlan(iface, network, matchLinkFile(files, iface)));
  }
  return plans;
}

/** Périphériques virtuels déclarés par `.netdev`. */
export function resolveNetdevs(vfs: VirtualFileSystem): PlannedNetdev[] {
  const out: PlannedNetdev[] = [];
  for (const file of discoverNetworkdFiles(vfs)) {
    if (file.kind !== 'netdev') continue;
    const name = get(file, 'NetDev', 'Name');
    const kind = get(file, 'NetDev', 'Kind');
    if (!name || !kind) continue;
    const idRaw = get(file, 'VLAN', 'Id');
    const vlanId = idRaw !== undefined ? Number(idRaw) : null;
    out.push({
      name,
      kind: kind.toLowerCase(),
      vlanId: Number.isFinite(vlanId) ? vlanId : null,
      path: file.path,
    });
  }
  return out;
}
