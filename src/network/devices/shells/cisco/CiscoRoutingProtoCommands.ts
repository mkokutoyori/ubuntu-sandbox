/**
 * CiscoRoutingProtoCommands — config-router for RIP / EIGRP / BGP.
 *
 * RIP keeps using the REAL RIP engine for network/version/enable; the
 * extra RIP knobs and the (engine-less) EIGRP/BGP processes are
 * recorded in RoutingConfigRepository as real remembered config and
 * projected by the show family. A lone device has no peers, so BGP
 * neighbours stay Idle and EIGRP shows 0 neighbours — the true state.
 */
import { IPAddress, SubnetMask } from '../../../core/types';
import { isValidIPv4 } from '../../../core/ip';
import { CliInvalidInput, CliIncomplete } from '../cli/CliDiagnostic';
import { CISCO_ERRORS } from '../cli-utils';
import type { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { classfulMask } from './CiscoConfigCommands';
import type { RoutingConfigRepository }
  from '../../inspection/config/RoutingConfigRepository';
import { parseRedistribute, upsertRedistribute }
  from '../../inspection/config/RoutingConfigRepository';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec, EnumValue } from '@/cli/ArgumentTypes';
import type { SpecCollector, AdapterKeyword } from '@/cli/commands/trieAdapter';
import { collectRegistrations, specsFromTrieRegistrations }
  from '@/cli/commands/trieAdapter';
import { showIpProtocols } from './CiscoShowCommands';
import {
  showIpEigrpNeighbors, showIpEigrpNeighborsDetail,
  showIpEigrpTopology, showIpEigrpInterfaces, eigrpProtocolBlock,
} from './CiscoEigrpShow';


type Proto = 'rip' | 'eigrp' | 'bgp';

function curProto(ctx: CiscoShellContext): { proto: Proto; asn?: number } {
  return ctx.getSelectedRoutingProto() ?? { proto: 'rip' };
}

/**
 * `config-router` est un seul arbre pour trois protocoles, et c'est la
 * source unique qui dit à qui appartient chaque mot-clé. Les
 * gestionnaires la lisent pour refuser, l'aide la lit pour ne pas
 * proposer : le refus et la proposition ne peuvent donc pas diverger,
 * ce qui était exactement le défaut — `router rip` offrait
 * `neighbor … remote-as`, que la même machine refusait ensuite.
 *
 * Un mot-clé absent de la table appartient aux trois.
 */
export const ROUTER_MODE_OWNERS: ReadonlyMap<string, readonly Proto[]> = new Map([
  ['version', ['rip']],
  ['auto-summary', ['rip', 'eigrp']],
  ['passive-interface', ['rip', 'eigrp']],
  ['offset-list', ['rip', 'eigrp']],
  ['output-delay', ['rip']],
  ['flash-update-threshold', ['rip']],
  ['validate-update-source', ['rip']],
  ['distribute-list', ['rip', 'eigrp']],
  ['traffic-share', ['eigrp']],
  ['variance', ['eigrp']],
  ['metric', ['eigrp']],
  ['eigrp', ['eigrp']],
  ['router-id', ['eigrp', 'bgp']],
  ['bgp', ['bgp']],
  ['aggregate-address', ['bgp']],
  ['address-family', ['bgp']],
  ['exit-address-family', ['bgp']],
  ['synchronization', ['bgp']],
] as ReadonlyArray<[string, readonly Proto[]]>);

export function routerKeywordBelongsTo(keyword: string, proto: Proto): boolean {
  const bare = keyword.toLowerCase().replace(/^no\s+/, '');
  const owners = ROUTER_MODE_OWNERS.get(bare);
  return !owners || owners.includes(proto);
}

/** Refuse au caret un mot-clé qui n'appartient pas au protocole courant. */
function requireProto(ctx: CiscoShellContext, keyword: string): void {
  if (!routerKeywordBelongsTo(keyword, curProto(ctx).proto)) throw new CliInvalidInput();
}

const STUB_OPTIONS = [
  'connected', 'summary', 'static', 'redistributed', 'receive-only', 'leak-map',
];

export function toWildcard(mask: string | undefined): string | undefined {
  if (!mask || mask === 'mask') return undefined;
  const o = mask.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return mask;
  }
  const contiguous = /^1*0*$/.test(o.map((n) => n.toString(2).padStart(8, '0')).join(''));
  if (!contiguous || o[0] === 0) return mask;
  return o.map((n) => 255 - n).join('.');
}

/**
 * A `network` statement names a classful unicast network: multicast,
 * experimental and loopback addresses can never carry a RIP adjacency.
 */
function ripRoutableNetwork(addr: string): boolean {
  const first = parseInt(addr.split('.')[0], 10);
  return first > 0 && first < 224 && first !== 127;
}

function pushOnce(list: string[], value: string): boolean {
  if (list.includes(value)) return false;
  list.push(value);
  return true;
}

export function buildRoutingProtoConfig(
  configTrie: CommandTrie, routerTrie: CommandTrie,
  ctx: CiscoShellContext, repo: RoutingConfigRepository,
): void {
  // ── process enters (router rip is in CiscoConfigCommands) ──
  // Real engines (RIB-integrated, config-driven adjacency).
  const eigrpEng = () => ctx.r().getEIGRPEngine();
  const bgpEng = () => ctx.r().getBGPEngine();
  const converge = () => ctx.r().convergeDynamicRouting();

  configTrie.registerGreedy('router eigrp', 'Enter EIGRP configuration', (a) => {
    if (a.length < 1) return CISCO_ERRORS.INCOMPLETE;
    if (!/^\d+$/.test(a[0])) throw new CliInvalidInput({ token: a[0] });
    const asn = parseInt(a[0], 10);
    if (asn < 1 || asn > 65535) throw new CliInvalidInput({ token: a[0] });
    repo.ensureEigrp(asn);
    eigrpEng().enable({ asn });
    ctx.setSelectedRoutingProto({ proto: 'eigrp', asn });
    ctx.setMode('config-router');
    converge();
    return '';
  });
  configTrie.registerGreedy('no router eigrp', 'Disable EIGRP', (a) => {
    repo.removeEigrp(parseInt(a[0], 10) || 0);
    eigrpEng().disable();
    converge();
    return '';
  });
  configTrie.registerGreedy('router bgp', 'Enter BGP configuration', (a) => {
    if (a.length < 1) return CISCO_ERRORS.INCOMPLETE;
    if (!/^\d+$/.test(a[0])) throw new CliInvalidInput();
    const asn = parseInt(a[0], 10);
    if (asn < 1 || asn > 4294967295) return '% Invalid AS number';
    const existing = repo.getBgp();
    if (existing && existing.asn !== asn) {
      return `% Currently a BGP peer to AS ${existing.asn}`;
    }
    repo.ensureBgp(asn);
    bgpEng().enable({ asn });
    ctx.setSelectedRoutingProto({ proto: 'bgp', asn });
    ctx.setMode('config-router');
    converge();
    return '';
  });
  configTrie.registerGreedy('no router bgp', 'Disable BGP', () => {
    repo.removeBgp();
    bgpEng().disable();
    converge();
    return '';
  });

  buildRouterSubmodeOn(routerTrie, ctx, repo);
}


export function buildRouterSubmodeOn(
  routerTrie: CommandTrie,
  ctx: CiscoShellContext, repo: RoutingConfigRepository,
): void {
  const eigrpEng = () => ctx.r().getEIGRPEngine();
  const bgpEng = () => ctx.r().getBGPEngine();
  const converge = () => ctx.r().convergeDynamicRouting();

  // ── config-router sub-commands (proto-aware) ──
  const eigrp = () => repo.ensureEigrp(curProto(ctx).asn ?? 0);
  const bgp = () => repo.getBgp();

  routerTrie.registerGreedy('network', 'Advertise a network', (args) => {
    const { proto } = curProto(ctx);
    if (proto === 'rip') {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      if (!ctx.r().isRIPEnabled()) return '% RIP is not enabled.';
      if (!isValidIPv4(args[0]) || !ripRoutableNetwork(args[0])) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      const net = new IPAddress(args[0]);
      const mask = classfulMask(net);
      const classful = net.networkAddress(mask);
      ctx.r().ripAdvertiseNetwork(classful, mask);
      pushOnce(repo.rip.networks, classful.toString());
      return '';
    }
    if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
    if (!isValidIPv4(args[0])) return CISCO_ERRORS.INVALID_INPUT;
    if (proto === 'eigrp') {
      const wildcard = toWildcard(args[1]);
      if (pushOnce(eigrp().networks, [args[0], wildcard].filter(Boolean).join(' '))) {
        eigrpEng().getConfig().networks.push({ network: args[0], wildcard });
      }
    } else {
      const proc = bgp();
      if (proc && !pushOnce(proc.networks, args.join(' '))) return '';
      const mask = args[1] === 'mask' && args[2]
        ? args[2] : String(classfulMask(new IPAddress(args[0])));
      bgpEng().getConfig().networks.push({ network: args[0], mask });
    }
    converge();
    return '';
  });

  routerTrie.registerGreedy('no network', 'Stop advertising a network', (args) => {
    const { proto } = curProto(ctx);
    if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
    if (!isValidIPv4(args[0])) return CISCO_ERRORS.INVALID_INPUT;
    if (proto === 'rip') {
      const net = new IPAddress(args[0]);
      const classful = net.networkAddress(classfulMask(net)).toString();
      ctx.r().ripWithdrawNetwork(new IPAddress(classful));
      repo.rip.networks = repo.rip.networks.filter((n) => n !== classful);
      return '';
    }
    if (proto === 'eigrp') {
      const p = eigrp();
      p.networks = p.networks.filter((n) => n.split(/\s+/)[0] !== args[0]);
      const ec = eigrpEng().getConfig();
      ec.networks = ec.networks.filter((n) => n.network !== args[0]);
      converge();
      return '';
    }
    const proc = bgp();
    if (proc) proc.networks = proc.networks.filter((n) => n.split(/\s+/)[0] !== args[0]);
    return '';
  });

  routerTrie.register('version 2', 'Use RIPv2', () => {
    repo.rip.version = 2;
    ctx.r()._setRipVersion(2);
    return '';
  });
  routerTrie.register('version 1', 'Use RIPv1', () => {
    repo.rip.version = 1;
    ctx.r()._setRipVersion(1);
    return '';
  });
  routerTrie.register('no version', 'Restore default version control', () => {
    repo.rip.version = null;
    ctx.r()._setRipVersion(1);
    return '';
  });

  routerTrie.register('no router rip', 'Disable RIP', () => {
    ctx.r().disableRIP();
    ctx.setSelectedRoutingProto(null);
    ctx.setMode('config');
    return '';
  });
  routerTrie.register('auto-summary', 'Enable auto-summary', () => {
    const p = curProto(ctx).proto;
    if (p === 'rip') repo.rip.autoSummary = true;
    else if (p === 'eigrp') eigrp().autoSummary = true;
    return '';
  });
  routerTrie.register('no auto-summary', 'Disable auto-summary', () => {
    const p = curProto(ctx).proto;
    if (p === 'rip') repo.rip.autoSummary = false;
    else if (p === 'eigrp') eigrp().autoSummary = false;
    return '';
  });
  // passive-interface mirrors IOS: the engine stops transmitting on the
  // interface but keeps processing received updates. Config is recorded
  // both in the repo (show running-config) and in the live engine.
  const setPassive = (p: Proto, ifName: string, passive: boolean) => {
    if (p === 'rip') {
      if (passive) { repo.rip.passive.add(ifName); ctx.r().ripSetPassiveInterface(ifName); }
      else { repo.rip.passive.delete(ifName); ctx.r().ripRemovePassiveInterface(ifName); }
    } else if (p === 'eigrp') {
      if (passive) {
        eigrp().passive.add(ifName);
        eigrpEng().getConfig().passive.add(ifName);
        eigrpEng().onInterfacePassive(ifName);
      } else {
        eigrp().passive.delete(ifName);
        eigrpEng().getConfig().passive.delete(ifName);
      }
      converge();
    }
  };
  routerTrie.registerGreedy('passive-interface', 'Suppress updates', (a) => {
    if (a.length < 1) return CISCO_ERRORS.INCOMPLETE;
    const p = curProto(ctx).proto;
    if (a[0].toLowerCase() === 'default') {
      if (p === 'rip') repo.rip.passiveDefault = true;
      else if (p === 'eigrp') eigrp().passiveDefault = true;
      for (const name of ctx.r()._getPortsInternal().keys()) setPassive(p, name, true);
      return '';
    }
    const ifName = ctx.resolveInterfaceName(a.join(' '));
    if (!ifName) return '%Invalid interface type and number';
    setPassive(p, ifName, true);
    return '';
  });
  routerTrie.registerGreedy('no passive-interface', 'Allow updates', (a) => {
    if (a.length < 1) return CISCO_ERRORS.INCOMPLETE;
    const p = curProto(ctx).proto;
    if (a[0].toLowerCase() === 'default') {
      if (p === 'rip') repo.rip.passiveDefault = false;
      else if (p === 'eigrp') eigrp().passiveDefault = false;
      for (const name of ctx.r()._getPortsInternal().keys()) setPassive(p, name, false);
      return '';
    }
    const ifName = ctx.resolveInterfaceName(a.join(' '));
    if (!ifName) return '%Invalid interface type and number';
    setPassive(p, ifName, false);
    return '';
  });
  const RIP_REDIST_SOURCES = ['static', 'connected', 'ospf', 'eigrp', 'bgp'] as const;
  const parseRipRedistSource = (token: string | undefined) =>
    RIP_REDIST_SOURCES.find((s) => s === (token ?? '').toLowerCase());
  const REDIST_PROTOCOLS = ['connected', 'static', 'rip', 'ospf', 'eigrp', 'bgp', 'isis'];
  routerTrie.registerGreedy('redistribute', 'Redistribute routes', (a) => {
    if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
    if (!REDIST_PROTOCOLS.includes(a[0].toLowerCase())) return CISCO_ERRORS.INVALID_INPUT;
    const parsed = parseRedistribute(a);
    if (!parsed) throw new CliInvalidInput();
    const p = curProto(ctx).proto;
    if (p === 'rip') {
      const source = parseRipRedistSource(a[0]);
      if (!source) return CISCO_ERRORS.INVALID_INPUT;
      ctx.r().ripSetRedistribution(source, parsed.metric?.[0]);
      upsertRedistribute(repo.rip.redistribute, parsed);
    } else if (p === 'eigrp') {
      upsertRedistribute(eigrp().redistribute, parsed);
      const source = parseRipRedistSource(a[0]) ?? (a[0]?.toLowerCase() === 'rip' ? 'rip' : undefined);
      if (source && source !== 'eigrp') {
        eigrpEng().setRedistribution(source as 'static' | 'connected' | 'rip' | 'ospf' | 'bgp');
        converge();
      }
      if (!parsed.metric && eigrp().defaultMetric === undefined
        && a[0].toLowerCase() !== 'connected') {
        return '% Warning: Redistributing without default metric — '
          + 'routes will not be advertised until a metric is set';
      }
    } else {
      const proc = bgp();
      if (proc) upsertRedistribute(proc.redistribute, parsed);
    }
    return '';
  });
  routerTrie.registerGreedy('no redistribute', 'Stop redistributing routes', (a) => {
    const p = curProto(ctx).proto;
    if (p === 'eigrp') {
      const source = (a[0] ?? '').toLowerCase();
      if (source === 'static' || source === 'connected' || source === 'rip'
        || source === 'ospf' || source === 'bgp') {
        eigrpEng().removeRedistribution(source);
        eigrp().redistribute = eigrp().redistribute.filter((s) => s.protocol !== source);
        converge();
      }
      return '';
    }
    if (p === 'rip') {
      const source = parseRipRedistSource(a[0]);
      if (!source) return '% Invalid input detected.';
      ctx.r().ripRemoveRedistribution(source);
      repo.rip.redistribute = repo.rip.redistribute.filter((s) => s.protocol !== source);
    }
    return '';
  });
  routerTrie.registerGreedy('default-information', 'Default route control', () => {
    if (curProto(ctx).proto === 'rip') {
      repo.rip.defaultInfoOriginate = true;
      ctx.r().ripSetDefaultInformationOriginate(true);
    }
    return '';
  });
  routerTrie.registerGreedy('no default-information', 'Stop default route origination', () => {
    if (curProto(ctx).proto === 'rip') {
      repo.rip.defaultInfoOriginate = false;
      ctx.r().ripSetDefaultInformationOriginate(false);
    }
    return '';
  });
  routerTrie.registerGreedy('default-metric', 'Set default metric', (a) => {
    const m = parseInt(a[0], 10);
    if (curProto(ctx).proto === 'rip') {
      if (Number.isNaN(m)) return '% Invalid input detected.';
      repo.rip.defaultMetric = m;
      ctx.r().ripSetDefaultMetric(m);
    } else if (curProto(ctx).proto === 'eigrp') {
      if (Number.isNaN(m)) throw new CliInvalidInput({ token: a[0] });
      eigrp().defaultMetric = m;
    }
    return '';
  });
  routerTrie.registerGreedy('distance', 'Administrative distance', (a) => {
    if (curProto(ctx).proto !== 'rip') return '';
    if (a.length < 1) return CISCO_ERRORS.INCOMPLETE;
    if (!/^\d+$/.test(a[0])) return CISCO_ERRORS.INVALID_INPUT;
    const n = parseInt(a[0], 10);
    if (n < 1 || n > 255) return CISCO_ERRORS.INVALID_INPUT;
    repo.rip.distance = n;
    return '';
  });
  routerTrie.registerGreedy('timers', 'Adjust timers', (a, raw) => {
    const line = raw ?? `timers ${a.join(' ')}`.trim();
    const p = curProto(ctx).proto;
    if (p === 'rip') {
      if (a[0]?.toLowerCase() !== 'basic') return CISCO_ERRORS.INVALID_INPUT;
      const values = a.slice(1);
      if (values.length < 4) return CISCO_ERRORS.INCOMPLETE;
      if (values.length > 4) return CISCO_ERRORS.INVALID_INPUT;
      if (!values.every((v) => /^\d+$/.test(v) && Number(v) <= 4294967295)) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      const [update, invalid, holddown, flush] = values.map(Number);
      if (invalid <= update || flush <= invalid) return '% Invalid timers';
      repo.rip.timersBasic = `basic ${update} ${invalid} ${holddown} ${flush}`;
      ctx.r().ripConfigure({
        updateInterval: update * 1000,
        routeTimeout: invalid * 1000,
        gcTimeout: (flush - invalid) * 1000,
      });
      return '';
    }
    // `timers bgp <keepalive> <hold>` was accepted and rendered nowhere.
    if (p === 'bgp') { const b = bgp(); if (b) pushOnce(b.extras, line); }
    else if (p === 'eigrp') pushOnce(eigrp().extras, line);
    return '';
  });
  routerTrie.registerGreedy('no timers', 'Restore default timers', (a) => {
    if (curProto(ctx).proto !== 'rip') return '';
    if ((a[0] ?? 'basic').toLowerCase() !== 'basic') return CISCO_ERRORS.INVALID_INPUT;
    repo.rip.timersBasic = undefined;
    ctx.r().ripConfigure({
      updateInterval: 30_000, routeTimeout: 180_000, gcTimeout: 60_000,
    });
    return '';
  });
  routerTrie.registerGreedy('no maximum-paths', 'Restore default path count', () => {
    const p = curProto(ctx).proto;
    ctx.r().setMaximumPaths(p, 4);
    if (p === 'rip') repo.rip.maximumPaths = undefined;
    return '';
  });
  routerTrie.registerGreedy('no distance', 'Restore default distance', () => {
    if (curProto(ctx).proto === 'rip') repo.rip.distance = undefined;
    return '';
  });
  routerTrie.registerGreedy('maximum-paths', 'Max parallel routes', (a) => {
    const p = curProto(ctx).proto;
    if (a.length < 1) return CISCO_ERRORS.INCOMPLETE;
    if (!/^\d+$/.test(a[0])) return CISCO_ERRORS.INVALID_INPUT;
    const n = parseInt(a[0], 10);
    if (p === 'rip' && (n < 1 || n > 16)) return CISCO_ERRORS.INVALID_INPUT;
    if (n < 1 || n > 32) return CISCO_ERRORS.INVALID_INPUT;
    // Le plafond va au ROUTEUR, qui est la seule chose que le plan de
    // données consulte : sans cet appel, la valeur restait rangée dans
    // le magasin du protocole et ne bornait rien.
    ctx.r().setMaximumPaths(p, n);
    if (p === 'rip') repo.rip.maximumPaths = n;
    else if (p === 'eigrp') {
      eigrp().maximumPaths = n;
      eigrpEng().getConfig().maximumPaths = n;
      converge();
    }
    return '';
  });
  routerTrie.registerGreedy('neighbor', 'Configure a peer/neighbor', (a, raw) => {
    const { proto } = curProto(ctx);
    if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
    if (proto === 'rip') {
      if (!isValidIPv4(a[0])) return CISCO_ERRORS.INVALID_INPUT;
      repo.rip.neighbors.push(a[0]); return '';
    }
    if (proto === 'eigrp') {
      // EIGRP's own form is `neighbor <ip> <interface>` (a unicast
      // neighbour on a non-broadcast link). `remote-as` is a BGP keyword
      // and does not exist here — it used to fall through every branch
      // below and be accepted in silence, which reads as "configured".
      if (!isValidIPv4(a[0])) throw new CliInvalidInput();
      if (!a[1]) return CISCO_ERRORS.INCOMPLETE;
      if (!ctx.r().getPort(a[1])) throw new CliInvalidInput();
      return '';
    }
    if (proto === 'bgp') {
      const b = bgp();
      if (!b) return '';
      if (!a[1]) return CISCO_ERRORS.INCOMPLETE;
      if (a[1] === 'remote-as') {
        if (!a[2]) return CISCO_ERRORS.INCOMPLETE;
        const as = parseInt(a[2], 10);
        if (Number.isNaN(as) || as < 1 || as > 4294967295) return CISCO_ERRORS.INVALID_INPUT;
      }

      // `neighbor <nom> peer-group` (sans argument) DÉCLARE un gabarit.
      // Il ne crée aucun voisin : un groupe n'a pas de session et n'a
      // donc rien à faire dans la table des voisins ni dans
      // `show ip bgp summary`. C'était le défaut — le nom du groupe y
      // apparaissait comme un pair « AS 0, Idle » qui n'existe pas.
      if (a[1] === 'peer-group' && !a[2]) {
        repo.ensureBgpPeerGroup(a[0]);
        return '';
      }

      // Un nom déjà déclaré comme gabarit : la commande règle le
      // GABARIT, pas un voisin. C'est ce qui était refusé
      // (`neighbor IBGP remote-as 65000`), alors que la moitié
      // précédente était acceptée — accepter le début d'une
      // construction et refuser la suite est plus trompeur que tout
      // refuser.
      const groupe = repo.getBgpPeerGroup(a[0]);
      if (groupe) {
        if (a[1] === 'remote-as') groupe.remoteAs = parseInt(a[2], 10);
        else if (a[1] === 'description') groupe.description = a.slice(2).join(' ');
        else if (a[1] === 'update-source') groupe.updateSource = a[2];
        else if (a[1] === 'activate') groupe.activated = true;
        else groupe.attrs.push(raw ?? a.join(' '));
        // L'ordre ne doit pas compter : régler le gabarit APRÈS que des
        // membres l'ont rejoint doit les atteindre quand même.
        for (const membre of repo.applyBgpPeerGroup(a[0])) {
          const ec2 = bgpEng().getConfig();
          let bm = ec2.neighbors.get(membre.ip);
          if (!bm) { bm = { ip: membre.ip, activated: false }; ec2.neighbors.set(membre.ip, bm); }
          if (membre.remoteAs !== undefined) bm.remoteAs = membre.remoteAs;
          if (membre.activated) bm.activated = true;
        }
        converge();
        return '';
      }

      if (!isValidIPv4(a[0])) return CISCO_ERRORS.INVALID_INPUT;
      // Rejoindre un groupe non déclaré est refusé, comme sur IOS :
      // sinon le voisin hériterait d'un gabarit qui n'existe pas.
      if (a[1] === 'peer-group' && a[2] && !repo.getBgpPeerGroup(a[2])) {
        return `% Configure the peer-group ${a[2]} first`;
      }

      const n = repo.ensureBgpNeighbor(a[0]);
      if (n) {
        if (a[1] === 'remote-as') n.remoteAs = parseInt(a[2], 10);
        else if (a[1] === 'description') n.description = a.slice(2).join(' ');
        else if (a[1] === 'update-source') n.updateSource = a[2];
        else if (a[1] === 'peer-group') n.peerGroup = a[2];
        else if (a[1] === 'activate') n.activated = true;
        else n.attrs.push(raw ?? a.join(' '));
      }
      // Drive the real BGP engine session config.
      const ec = bgpEng().getConfig();
      let bn = ec.neighbors.get(a[0]);
      if (!bn) { bn = { ip: a[0], activated: false }; ec.neighbors.set(a[0], bn); }
      if (a[1] === 'remote-as') bn.remoteAs = parseInt(a[2], 10);
      else if (a[1] === 'activate') bn.activated = true;
      else if (a[1] === 'weight') {
        const w = parseInt(a[2], 10);
        if (Number.isNaN(w) || w < 0 || w > 65535) return '% Invalid weight (0-65535)';
        bn.weight = w;
      } else if (a[1] === 'peer-group' && a[2]) {
        // L'adhésion fait hériter tout de suite : c'est ce qui rend le
        // gabarit utile plutôt que décoratif.
        repo.applyBgpPeerGroup(a[2]);
        if (n?.remoteAs !== undefined) bn.remoteAs = n.remoteAs;
        if (n?.activated) bn.activated = true;
      }
      converge();
    }
    return '';
  });
  routerTrie.registerGreedy('router-id', 'Set router-id', (a) => {
    if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
    if (!isValidIPv4(a[0])) return CISCO_ERRORS.INVALID_INPUT;
    const p = curProto(ctx).proto;
    if (p === 'eigrp') { eigrp().routerId = a[0]; eigrpEng().getConfig().routerId = a[0]; }
    else if (p === 'bgp') {
      const b = bgp(); if (b) b.routerId = a[0];
      bgpEng().getConfig().routerId = a[0];
    }
    return '';
  });
  routerTrie.registerGreedy('eigrp', 'EIGRP option', (a) => {
    if (a[0] === 'router-id') {
      if (!a[1]) return CISCO_ERRORS.INCOMPLETE;
      if (!isValidIPv4(a[1])) throw new CliInvalidInput({ token: a[1] });
      eigrp().routerId = a[1];
      eigrpEng().getConfig().routerId = a[1];
      return '';
    }
    if (a[0] === 'stub') {
      const words = a.slice(1).map((m) => m.toLowerCase());
      const unknown = words.find((m) => !STUB_OPTIONS.includes(m));
      if (unknown) throw new CliInvalidInput({ token: unknown });
      const chosen = words.length ? words : ['connected', 'summary'];
      eigrp().stub = chosen.join(' ');
      eigrpEng().setStub({
        connected: chosen.includes('connected'),
        summary: chosen.includes('summary'),
        staticRoutes: chosen.includes('static'),
        redistributed: chosen.includes('redistributed'),
        receiveOnly: chosen.includes('receive-only'),
      });
      return '';
    }
    throw new CliInvalidInput({ token: a[0] });
  });
  routerTrie.registerGreedy('no eigrp', 'Remove an EIGRP option', (a) => {
    if (a[0] === 'stub') {
      eigrp().stub = undefined;
      eigrpEng().setStub(null);
    } else if (a[0] === 'router-id') {
      eigrp().routerId = undefined;
      eigrpEng().getConfig().routerId = undefined;
    }
    return '';
  });
  routerTrie.registerGreedy('variance', 'EIGRP variance', (a) => {
    if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
    const v = parseInt(a[0], 10);
    if (Number.isNaN(v) || v < 1 || v > 128) {
      throw new CliInvalidInput({ token: a[0] });
    }
    eigrp().variance = v;
    eigrpEng().getConfig().variance = v;
    converge();
    return '';
  });
  routerTrie.registerGreedy('metric', 'Metric options', (a) => {
    const { proto } = curProto(ctx);
    if (proto === 'rip') {
      // `default-metric`-style RIP knob recorded as remembered config.
      const n = parseInt(a[a.length - 1] ?? '', 10);
      if (!isNaN(n)) repo.rip.defaultMetric = n;
      return '';
    }
    if (proto === 'eigrp') {
      // `metric maximum-hops <n>` — le diamètre au-delà duquel une route
      // est déclarée inaccessible. Valeur réelle, rangée sur le processus
      // et rendue par `show ip protocols`, plutôt qu'un mot avalé.
      if (a[0] === 'maximum-hops') {
        const h = parseInt(a[1] ?? '', 10);
        if (Number.isNaN(h) || h < 1 || h > 255) return '% Invalid input detected.';
        eigrp().maximumHops = h;
        return '';
      }
      // `metric weights <tos> k1 k2 k3 k4 k5` — feeds the composite metric.
      if (a[0] !== 'weights') return '% Invalid input detected.';
      const ks = a.slice(2, 7).map((n) => parseInt(n, 10));
      if (ks.length < 5 || ks.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
        return '% Invalid metric weights';
      }
      eigrpEng().getConfig().kValues = {
        k1: ks[0], k2: ks[1], k3: ks[2], k4: ks[3], k5: ks[4],
      };
      converge();
    }
    return '';
  });
  // `no bgp default ipv4-unicast` : la première ligne de toute
  // configuration MP-BGP, et elle était refusée. Le drapeau est réel —
  // il décide si un voisin échange des préfixes IPv4 sans avoir été
  // explicitement `activate`é dans sa famille.
  routerTrie.registerGreedy('no bgp', 'Disable a BGP option', (a) => {
    const b = bgp();
    if (!b) return '';
    if (a[0] === 'default' && a[1] === 'ipv4-unicast') {
      b.defaultIpv4Unicast = false;
      return '';
    }
    return '';
  });
  routerTrie.registerGreedy('bgp', 'BGP option', (a) => {
    if (a[0] === 'default' && a[1] === 'ipv4-unicast') {
      const b = bgp(); if (b) b.defaultIpv4Unicast = true;
      return '';
    }
    if (a[0] === 'router-id') {
      const b = bgp(); if (b) b.routerId = a[1];
      bgpEng().getConfig().routerId = a[1];
    } else if (a[0] === 'default' && a[1] === 'local-preference') {
      const lp = parseInt(a[2], 10);
      if (Number.isNaN(lp) || lp < 0) return '% Invalid local-preference';
      bgpEng().getConfig().defaultLocalPref = lp;
      converge();
    } else {
      // Every other `bgp <option>` — `log-neighbor-changes` and friends —
      // was accepted and rendered nowhere. Keep the line as typed.
      const b = bgp();
      if (b) pushOnce(b.extras, `bgp ${a.join(' ')}`.trim());
    }
    return '';
  });
  routerTrie.registerGreedy('aggregate-address', 'BGP aggregate', (a, raw) => {
    // Verbatim, NOT in `networks`: rendered from there it came back as
    // ` network aggregate-address …`, a line IOS rejects on reload.
    bgp()?.extras.push(raw ?? `aggregate-address ${a.join(' ')}`);
    return '';
  });
  routerTrie.registerGreedy('address-family', 'Enter address-family', (a) => {
    const p = curProto(ctx).proto;
    if (p !== 'bgp') throw new CliInvalidInput();
    const af = a.join(' ');
    const proc = bgp();
    if (proc && !proc.addressFamilies.includes(af)) proc.addressFamilies.push(af);
    ctx.setMode('config-router-af');
    return '';
  });
  routerTrie.register('exit-address-family', 'Leave address-family', () => {
    ctx.setMode('config-router');
    return '';
  });
  const PROTO_EXTRAS = [
    'offset-list', 'output-delay', 'flash-update-threshold',
    'validate-update-source', 'no validate-update-source',
    'traffic-share', 'distribute-list',
  ];
  for (const kw of PROTO_EXTRAS) {
    routerTrie.registerGreedy(kw, `Routing option (${kw})`, (args) => {
      requireProto(ctx, kw);
      const p = curProto(ctx).proto;
      const line = `${kw}${args.length ? ' ' + args.join(' ') : ''}`;
      if (p === 'rip') pushOnce(repo.rip.extras, line);
      else pushOnce(eigrp().extras, line);
      return '';
    });
  }
  routerTrie.requireArgs('address-family', 1);
  routerTrie.requireArgs('no neighbor', 1);
  for (const kw of ['synchronization', 'no synchronization']) {
    routerTrie.register(kw, `BGP ${kw}`, () => {
      const proc = bgp();
      if (curProto(ctx).proto !== 'bgp' || !proc) throw new CliInvalidInput();
      proc.extras = proc.extras.filter((l) => l !== 'synchronization' && l !== 'no synchronization');
      proc.extras.push(kw);
      return '';
    });
  }
  routerTrie.registerGreedy('no neighbor', 'Remove a neighbor', (a) => {
    const proc = bgp();
    if (curProto(ctx).proto === 'bgp' && proc) {
      if (a.length === 1) {
        proc.neighbors.delete(a[0]);
        proc.peerGroups.delete(a[0]);
        bgpEng().getConfig().neighbors.delete(a[0]);
      } else {
        const n = proc.neighbors.get(a[0]);
        if (n && a[1] === 'activate') n.activated = false;
        if (n && a[1] === 'peer-group') n.peerGroup = undefined;
      }
      converge();
      return '';
    }
    if (curProto(ctx).proto === 'rip') {
      repo.rip.neighbors = repo.rip.neighbors.filter((n) => n !== a[0]);
      return '';
    }
    throw new CliInvalidInput();
  });
}

// ── show family ──────────────────────────────────────────────────

export function registerRoutingProtoShow(
  trie: CommandTrie, ctx: CiscoShellContext, repo: RoutingConfigRepository,
): void {
  // Live engines drive neighbour/session/route state (converge first
  // so it reflects the real topology); the repo supplies configured
  // metadata (remote-as, description) the engine doesn't model.
  const bgpE = () => ctx.r().getBGPEngine();
  const eigrpE = () => ctx.r().getEIGRPEngine();
  const live = () => ctx.r().convergeDynamicRouting();

  trie.registerGreedy('show ip bgp summary', 'Display BGP neighbour summary', () => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const c = e.getConfig();
    const byId = new Map(e.getNeighbors().map((n) => [n.id, n]));
    const rows = [
      `BGP router identifier ${c.routerId ?? '0.0.0.0'}, local AS number ${c.asn}`,
      '',
      'Neighbor        V    AS  MsgRcvd  MsgSent  TblVer  InQ OutQ Up/Down  State/PfxRcd',
    ];
    for (const [ip, cfg] of c.neighbors) {
      const v = byId.get(ip);
      const upDown = v && v.isUp ? `${v.uptimeSec}s` : 'never';
      const state = v ? v.state : 'Idle';
      rows.push(`${ip.padEnd(16)}4 ${String(cfg.remoteAs ?? 0).padEnd(5)}` +
        `      0        0       0    0    0 ${upDown.padEnd(8)} ${state}`);
    }
    return rows.join('\n');
  });
  const BGP_TABLE_HEAD = '     Network          Next Hop            Metric LocPrf Weight Path';
  const bgpTableRows = (rows: ReturnType<ReturnType<typeof bgpE>['getBgpTable']>): string[] =>
    rows.map((r) => {
      const prefix = `${r.network}/${r.mask.toCIDR()}`;
      const nextHop = String(r.nextHop ?? '0.0.0.0');
      const path = r.asPath.length ? `${r.asPath.join(' ')} i` : 'i';
      return `*>   ${prefix.padEnd(17)}${nextHop.padEnd(20)}`
        + `0         ${String(r.weight).padStart(5)} ${path}`;
    });

  trie.registerGreedy('show ip bgp neighbors', 'Display BGP neighbors', (a) => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const repoB = repo.getBgp();
    const byId = new Map(e.getNeighbors().map((n) => [n.id, n]));
    // `show ip bgp neighbors <ip> [advertised-routes|routes]` : les
    // arguments étaient ignorés, donc la commande rendait le détail de
    // TOUS les voisins quoi qu'on demande.
    const wanted = a[0] && isValidIPv4(a[0]) ? a[0] : null;
    const sub = (wanted ? a[1] : a[0])?.toLowerCase();
    if (wanted && !e.getConfig().neighbors.has(wanted)) {
      return `% No such neighbor or address family`;
    }
    if (sub === 'advertised-routes' || sub === 'routes') {
      if (!wanted) throw new CliIncomplete();
      const rows = sub === 'advertised-routes'
        ? e.getAdvertisedRoutes(wanted)
        : e.getBgpTable().filter((r) => String(r.nextHop ?? '') === wanted);
      const head = `Total number of prefixes ${rows.length}`;
      return rows.length
        ? [BGP_TABLE_HEAD, ...bgpTableRows(rows), head].join('\n')
        : head;
    }
    const out: string[] = [];
    for (const [ip, cfg] of e.getConfig().neighbors) {
      if (wanted && ip !== wanted) continue;
      const v = byId.get(ip);
      const desc = repoB?.neighbors.get(ip)?.description ?? '(none)';
      out.push(`BGP neighbor is ${ip}, remote AS ${cfg.remoteAs ?? 'unset'}`);
      out.push(`  Description: ${desc}`);
      out.push(`  BGP state = ${v ? v.state : 'Idle'}` +
        `${v && v.isUp ? `, up for ${v.uptimeSec}s` : ''}`);
    }
    return out.length ? out.join('\n') : 'No bgp neighbors configured';
  });
  trie.registerGreedy('show ip bgp', 'Display BGP table', (a) => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const c = e.getConfig();
    let table = e.getBgpTable();
    // `show ip bgp <préfixe>` rejouait la table ENTIÈRE : l'argument
    // n'était pas lu. IOS répond sur ce préfixe-là, ou dit qu'il n'y est pas.
    if (a[0] && isValidIPv4(a[0])) {
      table = table.filter((r) => String(r.network) === a[0]);
      if (table.length === 0) return '% Network not in table';
    }
    const rows = [
      `BGP table version is 1, local router ID is ${c.routerId ?? '0.0.0.0'}`,
      BGP_TABLE_HEAD,
      ...bgpTableRows(table),
    ];
    return rows.join('\n');
  });
  trie.registerGreedy('show bgp', 'Display BGP', () => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const up = e.getNeighbors().filter((n) => n.isUp).length;
    return `BGP local AS ${e.getConfig().asn}, ` +
      `${e.getConfig().neighbors.size} neighbour(s), ${up} established`;
  });

  // Les vues du mode nommé, qui n'existaient pas. Elles lisent
  // exactement le même moteur que leurs équivalents classiques : un
  // routeur ne tient pas deux EIGRP selon la syntaxe employée pour le
  // configurer, et les faire diverger serait le vrai défaut.
  trie.registerGreedy('show eigrp protocols', 'Display EIGRP protocol instances', () => {
    const e = eigrpE();
    if (!e.isEnabled()) return '';
    const c = e.getConfig();
    const p = repo.ensureEigrp(c.asn);
    return [
      `EIGRP-IPv4 Protocol for AS(${c.asn})`,
      `  Metric weight K1=1, K2=0, K3=1, K4=0, K5=0`,
      `  Soft SIA disabled`,
      `  NSF-aware route hold timer is 240`,
      `  Router-ID: ${c.routerId ?? '0.0.0.0'}`,
      `  Topology : 0 (base)`,
      `    Active Timer: 3 min`,
      `    Distance: internal 90 external 170`,
      `    Maximum path: ${p.maximumPaths ?? 4}`,
      `    Maximum hopcount ${p.maximumHops ?? 100}`,
      `    Maximum metric variance ${p.variance ?? 1}`,
    ].join('\n');
  });

  trie.registerGreedy('show eigrp address-family ipv4 neighbors',
    'Display EIGRP neighbors (named mode)', () => {
      const e = eigrpE();
      if (!e.isEnabled()) return '';
      live();
      const out = [
        `EIGRP-IPv4 Address-Family Neighbors for AS(${e.getConfig().asn})`,
        'H   Address                 Interface       Hold Uptime   SRTT   RTO  Q  Seq',
        '                                            (sec)         (ms)       Cnt Num',
      ];
      e.getNeighbors().forEach((n, i) => {
        out.push(`${String(i).padEnd(4)}${n.address.padEnd(24)}${n.iface.padEnd(16)}`
          + `${String(15).padEnd(5)}${String(n.uptimeSec).padEnd(9)}1      200  0  1`);
      });
      return out.join('\n');
    });

  // `show ip eigrp traffic` — les compteurs sont RÉELS, alimentés aux
  // points d'émission et de réception du moteur. Query/Reply/SIA restent
  // à zéro et c'est un fait, pas un trou : ce moteur n'a pas d'état
  // Active et n'en émet donc jamais (voir `CLAUDE.md`).
  trie.registerGreedy('show ip eigrp traffic', 'Display EIGRP traffic statistics', () => {
    const e = eigrpE();
    if (!e.isEnabled()) return '';
    const t = e.traffic;
    return [
      `IP-EIGRP Traffic Statistics for AS ${e.getConfig().asn}`,
      `  Hellos sent/received: ${t.helloSent}/${t.helloRcvd}`,
      `  Updates sent/received: ${t.updateSent}/${t.updateRcvd}`,
      `  Queries sent/received: ${t.querySent}/${t.queryRcvd}`,
      `  Replies sent/received: ${t.replySent}/${t.replyRcvd}`,
      `  Acks sent/received: ${t.ackSent}/${t.ackRcvd}`,
      `  SIA-Queries sent/received: 0/0`,
      `  SIA-Replies sent/received: 0/0`,
      `  Hello Process ID: 0`,
      `  PDM Process ID: 0`,
    ].join('\n');
  });

  // `show ip eigrp accounting` — un état par voisin, lu de la table de
  // voisins vivante. Les colonnes de préfixes reflètent ce que le moteur
  // a réellement reçu de chacun.
  trie.registerGreedy('show ip eigrp accounting', 'Display EIGRP prefix accounting', () => {
    const e = eigrpE();
    if (!e.isEnabled()) return '';
    live();
    const voisins = e.getNeighbors();
    const out = [
      `EIGRP-IPv4 Accounting for AS(${e.getConfig().asn})`,
      `  Total Prefix Count: ${e.getTopologyTable().size}   States: A-Adjacency, P-Pending, D-Down`,
      '',
      'State   Address/Source     Interface   Prefix  Restart  Restart/  Reset',
      '                                       Count    Count    Uptime',
    ];
    for (const n of voisins) {
      out.push(`  A     ${n.address.padEnd(19)}${n.iface.padEnd(12)}`
        + `${String(e.getTopologyTable().size).padEnd(8)}0        00:00:00`);
    }
    return out.join('\n');
  });

  trie.registerGreedy('show ip eigrp neighbors', 'Display EIGRP neighbors', (a) => {
    const e = eigrpE();
    if (!e.isEnabled()) return '';
    live();
    return a[0]?.toLowerCase() === 'detail'
      ? showIpEigrpNeighborsDetail(e)
      : showIpEigrpNeighbors(e);
  });
  trie.registerGreedy('show ip eigrp topology', 'Display EIGRP topology', (a) => {
    const e = eigrpE();
    if (!e.isEnabled()) return '';
    live();
    return showIpEigrpTopology(e, a[0]?.toLowerCase() === 'all-links');
  });
  trie.registerGreedy('show ip eigrp interfaces', 'Display EIGRP interfaces', (a) => {
    const e = eigrpE();
    if (!e.isEnabled()) return '';
    live();
    const detail = a[0]?.toLowerCase() === 'detail';
    const nom = detail ? a[1] : a[0];
    const iface = nom ? ctx.resolveInterfaceName(nom) ?? nom : undefined;
    return showIpEigrpInterfaces(e, detail, iface);
  });

  trie.registerGreedy('show ip protocols vrf', 'Display routing protocols in a VRF', (a) => {
    if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
    const vrfs = (ctx.r() as unknown as { _vrfs?: Map<string, unknown> })._vrfs;
    if (!vrfs?.has(a[0])) return `% VRF ${a[0]} does not exist`;
    return `Routing Protocol is "connected"\n  VRF ${a[0]}`;
  });
  trie.register('show ip protocols', 'Display routing protocol state', () => {
    const out: string[] = [];
    // `showIpProtocols` rend DÉJÀ les blocs OSPF et RIP. L'appeler sous
    // condition de RIP laissait OSPF muet sans RIP ; lui ajouter un
    // second bloc OSPF ici le rendait deux fois avec RIP. Il est le seul
    // rendu, appelé sans condition.
    const canonique = showIpProtocols(ctx.r());
    if (canonique !== 'No routing protocol is configured.') out.push(canonique);
    for (const p of repo.allEigrp()) {
      out.push(...eigrpProtocolBlock(p, eigrpE(), ctx.r()));
    }
    const b = repo.getBgp();
    if (b) {
      out.push(`Routing Protocol is "bgp ${b.asn}"`);
      out.push(`  IGP synchronization is disabled`);
      out.push(`  Neighbor(s): ${b.neighbors.size}`);
      for (const n of b.neighbors.values()) {
        out.push(`    ${n.ip} remote-as ${n.remoteAs ?? 'unset'}`);
      }
    }
    return out.length ? out.join('\n') : 'No routing protocol is configured.';
  });
}

const ROUTING_PROTO_SHOW_KEYWORDS:
Readonly<Record<string, ReadonlyArray<{ keyword: string; description: string }>>> = {
  'show ip eigrp neighbors': [
    { keyword: 'detail', description: 'Show detailed peer information' },
  ],
  'show ip eigrp topology': [
    { keyword: 'all-links', description: 'Show all links in topology table' },
  ],
  'show ip eigrp interfaces': [
    { keyword: 'detail', description: 'Show detailed interface information' },
  ],
};

const ROUTING_PROTO_SHOW_ARGUMENTS: Readonly<Record<string, [string, string]>> = {
  'show ip bgp': ['A.B.C.D', 'Network in the BGP routing table to display'],
  'show ip protocols vrf': ['WORD', 'VRF name'],
  'show ip eigrp interfaces': ['WORD', 'Interface name'],
};

const BGP_NEIGHBORS_PATH = 'show ip bgp neighbors';

const BGP_NEIGHBOR_ADDRESS: ArgumentSpec = {
  name: 'neighbor', type: 'IP_ADDR', optional: true,
  description: 'Neighbor to display information about',
};

const BGP_NEIGHBOR_VIEWS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'advertised-routes', description: 'Routes advertised to this neighbor' },
  { keyword: 'routes', description: 'Routes learned from this neighbor' },
];

function bgpNeighborSpecs(action: (args: string[]) => string): CommandSpec[] {
  const words = BGP_NEIGHBORS_PATH.split(' ');
  const lire = (args: Record<string, string>): string =>
    String(args[BGP_NEIGHBOR_ADDRESS.name] ?? '').trim();

  const specs: CommandSpec[] = [{
    id: words.join('-'),
    path: [...words, BGP_NEIGHBOR_ADDRESS],
    description: 'Display BGP neighbors',
    modes: ['user', 'privileged'],
    minPrivilege: 1,
    run: ((_session: unknown, args: Record<string, string>) => {
      const adresse = lire(args);
      return action(adresse.length === 0 ? [] : [adresse]);
    }) as CommandSpec['run'],
  }];

  for (const vue of BGP_NEIGHBOR_VIEWS) {
    specs.push({
      id: [...words, vue.keyword].join('-'),
      path: [...words, BGP_NEIGHBOR_ADDRESS, vue.keyword],
      description: vue.description,
      modes: ['user', 'privileged'],
      minPrivilege: 1,
      run: ((_session: unknown, args: Record<string, string>) =>
        action([lire(args), vue.keyword])) as CommandSpec['run'],
    });
  }
  return specs;
}

export function routingProtoShowSpecs(
  ctx: CiscoShellContext, repo: RoutingConfigRepository,
): CommandSpec[] {
  const register = (collector: SpecCollector) => registerRoutingProtoShow(
    collector as unknown as CommandTrie, ctx, repo);

  const specs = specsFromTrieRegistrations(register, {
    modes: ['user', 'privileged'],
    minPrivilege: 1,
    skip: (path) => path === BGP_NEIGHBORS_PATH,
    restDescriptionFor: (path) => ROUTING_PROTO_SHOW_ARGUMENTS[path]?.[1],
    restLiteralFor: (path) => ROUTING_PROTO_SHOW_ARGUMENTS[path]?.[0],
    keywordsFor: (path) => ROUTING_PROTO_SHOW_KEYWORDS[path],
  });

  const voisins = collectRegistrations(register)
    .find((entry) => entry.path === BGP_NEIGHBORS_PATH);
  return voisins ? [...specs, ...bgpNeighborSpecs(voisins.action)] : specs;
}

/*
 * Ce qu'on peut redistribuer DEPEND du protocole ou l'on se trouve, et
 * une place enumeree ne sait pas le dire : son domaine est fixe a la
 * declaration. Sous `router rip`, le gestionnaire refuse `rip` — on ne
 * redistribue pas un protocole dans lui-meme — et `isis`, dont ce
 * simulateur n'a pas de moteur. Chaque source est donc un mot-cle, qui
 * porte sa propre joignabilite ; sans quoi `?` proposerait sous RIP deux
 * mots que la meme machine refuse, ce que le garde-fou
 * `probe-cli-aide-egale-execution` interdit — et c'est lui qui l'a
 * attrape.
 */
function redistribuable(
  ctx: CiscoShellContext, keyword: string, description: string,
  saufSousRip = false,
): AdapterKeyword {
  return {
    keyword, description,
    argument: { name: 'reste', type: 'REST', optional: true,
      description: 'Process number, `metric`, `route-map` or `subnets`' },
    ...(saufSousRip
      ? { reachableWhen: () => curProto(ctx).proto !== 'rip' } : {}),
  };
}

function redistributionKeywords(ctx: CiscoShellContext): ReadonlyArray<AdapterKeyword> {
  return [
    redistribuable(ctx, 'connected', 'Connected routes'),
    redistribuable(ctx, 'static', 'Static routes'),
    redistribuable(ctx, 'ospf', 'Open Shortest Path First'),
    redistribuable(ctx, 'eigrp', 'Enhanced Interior Gateway Routing Protocol'),
    redistribuable(ctx, 'bgp', 'Border Gateway Protocol'),
    redistribuable(ctx, 'rip', 'Routing Information Protocol', true),
    redistribuable(ctx, 'isis', 'ISO IS-IS', true),
  ];
}

/*
 * Les suites de `neighbor` etaient posees par la table de continuations
 * du trie, qui ne s'applique plus a un arbre vide : sans les declarer
 * ici, `neighbor 10.0.0.2 ?` aurait cesse d'annoncer `remote-as` et le
 * reste, en silence. Elles NOMMENT sans restreindre — un pair porte
 * bien d'autres reglages (`next-hop-self`, `password`, `prefix-list`…)
 * que le gestionnaire range tels quels.
 */
const NEIGHBOR_SOUS_COMMANDES: readonly EnumValue[] = [
  { keyword: 'remote-as', description: 'Autonomous system number of the neighbour' },
  { keyword: 'peer-group', description: 'Declare a peer-group, or join one' },
  { keyword: 'description', description: 'Text describing this neighbour' },
  { keyword: 'update-source', description: 'Interface the session is sourced from' },
  { keyword: 'activate', description: 'Enable this neighbour in the current address family' },
  { keyword: 'weight', description: 'Weight given to the routes this neighbour advertises' },
];

const ROUTER_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  network: [
    { name: 'reseau', type: 'IP_ADDR', description: 'Network number' },
    { name: 'reste', type: 'REST', optional: true,
      description: 'A wildcard or `mask <A.B.C.D>`, depending on the protocol' },
  ],
  redistribute: null,
  'default-metric': { name: 'metrique', type: 'REST',
    description: 'Metric given to a redistributed route' },
  distance: [
    { name: 'distance', type: 'INT', description: 'Administrative distance',
      range: [1, 255] },
    { name: 'reste', type: 'REST', optional: true,
      description: 'A source address and its wildcard' },
  ],
  timers: { name: 'valeurs', type: 'REST',
    description: '`basic <update> <invalid> <holddown> <flush>`' },
  'maximum-paths': { name: 'chemins', type: 'INT',
    description: 'Number of parallel routes', range: [1, 32] },
  /*
   * Le premier operande de `neighbor` n'est PAS toujours une adresse :
   * `neighbor IBGP peer-group` declare un gabarit, qui porte un NOM.
   * Le typer en adresse refuserait au caret la moitie de la famille
   * des peer-groups, que cette machine sait pourtant configurer.
   */
  neighbor: [
    {
      name: 'pair', type: 'WORD',
      description: 'Neighbour address, or the name of a peer-group',
      alternatives: [
        { keyword: 'A.B.C.D', description: 'Neighbour address' },
        { keyword: 'X:X:X:X::X', description: 'Neighbour IPv6 address' },
      ],
    },
    {
      name: 'reste', type: 'REST', optional: true,
      description: 'What to set on this neighbour',
      alternatives: NEIGHBOR_SOUS_COMMANDES,
    },
  ],
  'router-id': { name: 'identifiant', type: 'IP_ADDR',
    description: 'Router identifier, in the shape of an IPv4 address' },
  variance: { name: 'multiplicateur', type: 'INT',
    description: 'Metric variance multiplier', range: [1, 128] },
  /*
   * Ces deux places NOMMENT sans RESTREINDRE, et la nuance est ce qui
   * distingue une aide d'une regression. Sous RIP `metric 5` est un
   * simple nombre, et `bgp <option>` accepte tout ce que le
   * gestionnaire range en l'etat (`bestpath`, `deterministic-med`…) :
   * une place enumeree refuserait au caret ce que la machine execute.
   * Les formes connues sont donc des `alternatives` — ce que `?`
   * annonce — sur une place qui accepte le reste de la ligne.
   */
  metric: {
    name: 'reglage', type: 'REST', description: 'Metric parameter to set',
    alternatives: [
      { keyword: 'maximum-hops', description: 'Hop count beyond which a route is unreachable' },
      { keyword: 'weights', description: 'Coefficients of the composite metric' },
    ],
  },
  bgp: {
    name: 'option', type: 'REST', description: 'BGP process option',
    alternatives: [
      { keyword: 'default', description: 'Configure a BGP default' },
      { keyword: 'router-id', description: 'Router identifier of this BGP process' },
      { keyword: 'log-neighbor-changes', description: 'Log neighbour up/down events' },
    ],
  },
  'aggregate-address': [
    { name: 'reseau', type: 'IP_ADDR', description: 'Aggregate address' },
    { name: 'reste', type: 'REST', optional: true,
      description: 'A mask, then `summary-only` or `as-set`' },
  ],
  'address-family': [
    { name: 'famille', type: 'ENUM', description: 'Address family to enter',
      values: [
        { keyword: 'ipv4', description: 'IPv4 address family' },
        { keyword: 'ipv6', description: 'IPv6 address family' },
        { keyword: 'vpnv4', description: 'VPNv4 address family' },
      ] },
    { name: 'reste', type: 'REST', optional: true,
      description: '`unicast`, `multicast` or `vrf <name>`' },
  ],
  'passive-interface': {
    name: 'interface', type: 'REST',
    description: 'Interface that stops sending updates',
    alternatives: [
      { keyword: 'IFACE', description: 'Interface that stops sending updates' },
      { keyword: 'default', description: 'Every interface, unless listed otherwise' },
    ],
  },
  'default-information': { name: 'reste', type: 'REST', optional: true,
    description: '`originate`' },
  eigrp: null,
};

const EIGRP_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'router-id', description: 'Router identifier of this EIGRP process',
    argument: { name: 'identifiant', type: 'IP_ADDR',
      description: 'Router identifier, in the shape of an IPv4 address' },
  },
  {
    keyword: 'stub', description: 'Make this router an EIGRP stub',
    argument: { name: 'reste', type: 'REST', optional: true,
      description: '`connected`, `summary`, `static`, `redistributed`, `receive-only`' },
  },
];

/**
 * `config-router` est UN arbre pour trois protocoles, et c'est
 * `ROUTER_MODE_OWNERS` qui dit a qui appartient chaque mot-cle. Le trie
 * lisait cette table par un filtre de completion, qui ne gouverne que
 * l'AIDE ; au socle elle devient la joignabilite de la declaration, donc
 * elle gouverne l'aide ET l'execution — le refus et la proposition ne
 * peuvent pas diverger, ce qui est la raison d'etre de cette table.
 */
export function routerSubmodeSpecs(
  ctx: CiscoShellContext, repo: RoutingConfigRepository,
): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildRouterSubmodeOn(collector as unknown as CommandTrie, ctx, repo),
    {
      modes: ['config-router'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => ROUTER_ARGUMENTS[path],
      keywordsFor: (path) => path === 'eigrp' ? EIGRP_KEYWORDS
        : path === 'redistribute' ? redistributionKeywords(ctx) : undefined,
      /*
       * Le mot qui decide est celui qu'on NIE, pas `no`.
       * `routerKeywordBelongsTo` sait deja retirer un `no` de tete, mais
       * il lui faut ensuite le PREMIER mot : le filtre du trie lui
       * passait `path[0]`, donc `no` pour toute negation — un mot absent
       * de la table, qui appartient donc aux trois protocoles. `no
       * version` etait ainsi propose sous BGP, ou `version` n'existe pas.
       */
      reachableWhenFor: (path) => () => routerKeywordBelongsTo(
        path.replace(/^no\s+/i, '').split(/\s+/)[0], curProto(ctx).proto),
    },
  );
}
