import { renderTable, FIXED_TABLE } from '../../../shells/cli/TextTable';
import type { EnumValue } from '../../../../../cli/ArgumentTypes';
import type { Suggestion } from '../../../../../cli/CompletionEngine';
import type { FortiGate } from './FortiGate';
import { FORTIOS_PROFILE } from './FortiProfile';
import { FortiMessages, FORTI_COMMAND_FAIL, setHintsEnabled } from './FortiMessages';
import { FortiSocle } from './FortiSocle';
import { schemaIndex } from './schema';
import type { FortiCommitContext, FortiCommitDevice } from './schema/types';
import { FortiConfigTree } from './runtime/FortiConfigTree';
import { FortiNavigator, unquote } from './runtime/FortiNavigator';
import { FortiValidator } from './runtime/FortiValidator';
import { renderPath, renderWholeConfig } from './render/showRenderer';
import { renderGet } from './render/getRenderer';
import { makeSchedule } from '../../model/ScheduleObject';
import { makeIpPool, type IpPoolType } from '../../nat/IpPool';
import { vipAddress } from '../../model/AddressObject';
import { proxyOwnerKey, type Firewall } from '../../Firewall';
import type { PolicyRoutePrefix } from '../../l3/PolicyRouteTable';
import type { FortiCentralSnatPatch, FortiVipPatch } from './schema/types';
import { FortiDiagnostics } from './diag/FortiDiagnostics';
import { deniedLog, runDiagnose, runExecuteLog } from './diag/FortiDiagCommands';
import {
  renderArpTable, renderInterfaceStatus, renderPerformanceStatus,
  renderRoutingTable, renderSystemStatus,
} from './diag/getViews';
import type { FortiLogFormat } from './log/fortiLogFormat';
import {
  shouldLogTraffic, shouldLogTrafficStart, trafficCloseLog, trafficStartLog,
} from './log/trafficLog';

export { FORTI_COMMAND_FAIL };

export const FORTI_BUILD = '2662';

export class FortiShell {
  private readonly tree: FortiConfigTree;
  private readonly nav: FortiNavigator;
  private readonly socle: FortiSocle;
  private readonly diagnostics = new FortiDiagnostics();
  private vdom = 'root';

  constructor(private readonly fw: FortiGate) {
    this.tree = new FortiConfigTree(schemaIndex());
    const validator = new FortiValidator(
      (target, name) => this.referenceExists(target, name));
    this.nav = new FortiNavigator({
      tree: this.tree,
      validator,
      commitContext: () => this.commitContext(),
    });
    this.socle = new FortiSocle({
      tree: this.tree,
      nav: this.nav,
      hostname: () => this.fw.getName(),
      device: this.fw,
      candidatesFor: (targets) => this.candidatesFor(targets),
      view: (rest, full) => this.show(rest, full),
      inspect: (rest) => this.get(rest),
      diagnose: (rest) => this.diagnose(rest),
      runExecute: (rest) => this.executeVerb(rest),
    });
    this.fw.setTrafficLogger({
      onSessionOpened: (session, rule) => {
        if (!shouldLogTrafficStart(rule)) return;
        this.fw.getLogStore().append(
          trafficStartLog({ session, rule, now: this.fw.now() }));
      },
      onSessionClosed: (session, reason) => {
        const rule = session.policyId === undefined
          ? undefined
          : this.fw.getPolicyStore().byId(session.policyId);
        if (!shouldLogTraffic(rule)) return;
        this.fw.getLogStore().append(
          trafficCloseLog({ session, rule, now: this.fw.now() }, reason));
      },
      onDenied: (context) => {
        const rule = context.matchedPolicy;
        if (rule?.implicit === true && !this.logsImplicitDeny()) return;
        if (rule !== undefined && rule.implicit === false
          && !shouldLogTraffic(rule)) return;
        this.fw.getLogStore().append(deniedLog(context, this.fw.now()));
      },
    });
  }

  getPrompt(): string {
    const host = this.fw.getName();
    const label = this.nav.label();
    return label === null ? `${host} # ` : `${host} (${label}) # `;
  }

  getConfigTree(): FortiConfigTree {
    return this.tree;
  }

  completions(input: string): readonly string[] {
    const prefix = input.trimStart();
    const head = prefix.slice(0, prefix.lastIndexOf(' ') + 1);
    return this.socle.suggestions(prefix, 'TAB')
      .filter(s => !s.isArgument)
      .map(s => `${head}${s.value}`)
      .filter(w => w.startsWith(prefix) && w !== prefix);
  }

  help(inputBeforeQuestion = ''): readonly string[] {
    return this.describe(
      this.socle.suggestions(helpPrefix(inputBeforeQuestion), 'QUESTION_MARK'));
  }

  execute(rawLine: string): string {
    const line = rawLine.trim();
    if (line.length === 0) return '';
    if (line.endsWith('?')) {
      return this.help(line.slice(0, -1)).join('\n');
    }

    if (/^write\b/.test(line)) return FortiMessages.noSaveNeeded();
    if (/^show\s+full-configuration\b/.test(line)) {
      return this.show(splitTokens(line).slice(2), true);
    }

    const outcome = this.socle.execute(line);
    if (outcome.handled) return outcome.output;
    return this.refusal(line);
  }

  private refusal(line: string): string {
    const tokens = splitTokens(line);
    const object = this.nav.currentObject();

    if ((tokens[0] === 'set' || tokens[0] === 'unset' || tokens[0] === 'append'
      || tokens[0] === 'select' || tokens[0] === 'unselect')) {
      if (!object) return FortiMessages.setOutside(this.nav.currentTable());
      if (tokens[1] === undefined) return FortiMessages.incomplete('an attribute');

      const attribute = object.attribute(tokens[1]);
      if (!attribute) {
        return FortiMessages.unknownAttribute(tokens[1], object.spec.path.join(' '));
      }
      if (attribute.unimplemented) {
        return FortiMessages.unimplemented(tokens[1], attribute.unimplemented);
      }
      if (!object.isAvailable(attribute)) {
        return FortiMessages.commandFail(
          `\`${tokens[1]}\` does not apply in the current configuration of this object.`);
      }
      if (tokens[0] !== 'set' && !attribute.multiValue) {
        return FortiMessages.notMultiValue(tokens[0], tokens[1]);
      }
      return this.nav.set(tokens[1], tokens.slice(2));
    }

    if (tokens[0] === 'config') {
      return FortiMessages.unknownPath(tokens.slice(1).join(' '));
    }
    if (tokens[0] === 'edit') {
      return object
        ? FortiMessages.notATable(object.spec.path.join(' '))
        : FortiMessages.outsideTable('edit');
    }
    if (tokens[0] === 'move') {
      const table = this.nav.currentTable();
      if (table && !table.spec.ordered) {
        return FortiMessages.notOrdered('move', table.spec.path.join(' '));
      }
      return this.nav.move(tokens.slice(1));
    }
    if (tokens[0] === 'delete' || tokens[0] === 'purge' || tokens[0] === 'clone'
      || tokens[0] === 'rename') {
      if (!this.nav.currentTable()) return FortiMessages.outsideTable(tokens[0]);
      return this.applyTableVerb(tokens);
    }
    if (tokens[0] === 'next' || tokens[0] === 'abort') {
      return FortiMessages.outsideObject(tokens[0]);
    }
    if (tokens[0] === 'end') return this.nav.end();

    return FortiMessages.unknownCommand(tokens[0]);
  }

  private applyTableVerb(tokens: readonly string[]): string {
    switch (tokens[0]) {
      case 'delete': return this.nav.delete(tokens[1]);
      case 'purge': return this.nav.purge();
      case 'clone': return this.nav.clone(tokens.slice(1));
      case 'rename': return this.nav.rename(tokens.slice(1));
      default: return FORTI_COMMAND_FAIL;
    }
  }

  private commitContext(): FortiCommitContext {
    return {
      policy: this.fw.getPolicyStore(),
      objects: this.fw.getObjectStore(),
      device: this.commitDevice(),
      vdom: this.vdom,
      position: -1,
    };
  }

  private commitDevice(): FortiCommitDevice {
    const fw = this.fw;
    return {
      applyInterface(name, patch) {
        if (patch.ip && patch.mask) fw.configureInterface(name, { ip: patch.ip, mask: patch.mask });
        if (patch.up !== undefined) fw.setInterfaceUp(name, patch.up);
        if (patch.allowAccess) fw.setAllowedAccess(name, patch.allowAccess);
      },
      applyZone(name, members, intrazone) {
        const zones = fw.getZoneTable();
        if (!zones.getZone(name)) {
          zones.createZone(name, { intraZoneAction: intrazone === 'allow' ? 'allow' : 'deny' });
        }
        for (const member of members) zones.assignInterface(name, member);
      },
      removeZone(name) {
        fw.getZoneTable().deleteZone(name);
      },
      applyStaticRoute(route) {
        const routes = fw.getRouteTable();
        routes.removeStatic(route.destination, route.mask);
        if (!route.enabled || route.blackhole) return;
        routes.addStatic(route.destination, route.mask,
          route.gateway === '0.0.0.0' ? undefined : route.gateway,
          { iface: route.iface || undefined, distance: route.distance });
      },
      removeStaticRoute() {},
      applySchedule(schedule) {
        const built = makeSchedule(schedule.name, schedule.days, schedule.start, schedule.end);
        if (built) fw.setSchedule(built);
      },
      removeSchedule(name) {
        fw.getScheduleStore().remove(name);
      },
      applyVdomSettings(settings) {
        fw.setCentralNat(settings.centralNat);
      },
      applyIpPool(pool) {
        fw.setIpPool(makeIpPool({ ...pool, type: pool.type as IpPoolType }));
      },
      removeIpPool(name) {
        fw.removeIpPool(name);
      },
      applyVip(vip) {
        applyVipToFirewall(fw, vip);
      },
      removeVip(name) {
        fw.getNatPolicy().remove(vipRuleId(name));
        fw.getObjectStore().removeAddress(name);
        fw.clearProxyArpEntries(proxyOwnerKey('vip', name));
      },
      applyCentralSnat(entry) {
        applyCentralSnatToFirewall(fw, entry);
      },
      removeCentralSnat(id) {
        fw.getNatPolicy().remove(centralSnatRuleId(id));
      },
      applyPolicyRoute(route) {
        fw.getPolicyRoutes().upsert({
          id: route.id,
          enabled: route.enabled,
          action: route.action,
          inputDevices: route.inputDevices,
          sourcePrefixes: route.sources.map(toPrefix).filter(isPrefix),
          destinationPrefixes: route.destinations.map(toPrefix).filter(isPrefix),
          protocol: route.protocol,
          startPort: route.startPort,
          endPort: route.endPort,
          startSourcePort: route.startSourcePort,
          endSourcePort: route.endSourcePort,
          outputDevice: route.outputDevice,
          gateway: route.gateway,
          comment: route.comment,
        }, route.position);
      },
      removePolicyRoute(id) {
        fw.getPolicyRoutes().remove(id);
      },
      applyMemoryLog(patch) {
        if (patch.capacity !== undefined) fw.getLogStore().setCapacity(patch.capacity);
        if (patch.enabled === false) fw.getLogStore().clear();
      },
    };
  }

  private candidatesFor(targets: readonly string[]): readonly EnumValue[] {
    const out: EnumValue[] = [];
    const seen = new Set<string>();
    const push = (keyword: string, description: string): void => {
      if (seen.has(keyword)) return;
      seen.add(keyword);
      out.push({ keyword, description });
    };

    for (const target of targets) {
      const path = target.split(' ');
      const spec = this.tree.spec(path);
      for (const name of spec?.predefined ?? []) push(name, 'Predefined object.');

      const table = this.tree.existingTable(path);
      for (const key of table?.keys() ?? []) push(key, `Configured ${path[1] ?? target}.`);

      if (target === 'system interface') {
        for (const port of this.fw.getPortNames()) push(port, 'Physical interface.');
      }
      if (target === 'system zone') {
        for (const zone of this.fw.getZoneTable().list()) push(zone.name, 'Security zone.');
      }
      if (target === 'firewall service custom' || target === 'firewall service group') {
        push('ALL', 'All services.');
      }
      if (target.startsWith('firewall schedule')) {
        for (const name of this.fw.getScheduleStore().names()) push(name, 'Schedule.');
      }
      if (target === 'firewall ippool') {
        for (const name of this.fw.getIpPools().names()) push(name, 'IP pool.');
      }
    }
    return out;
  }

  private referenceExists(target: string, name: string): boolean {
    if (name === 'all' || name === 'any' || name === 'ALL') return true;
    return this.candidatesFor([target]).some(c => c.keyword === name);
  }

  private show(rest: readonly string[], full: boolean): string {
    const words = rest[0] === 'full-configuration' ? rest.slice(1) : rest;
    const options = { full: full || rest[0] === 'full-configuration' };

    if (words.length === 0) {
      const object = this.nav.currentObject();
      if (object) {
        return (renderPath(this.tree, object.spec.path, options) ?? []).join('\n');
      }
      const table = this.nav.currentTable();
      if (table) return (renderPath(this.tree, table.spec.path, options) ?? []).join('\n');
      return renderWholeConfig(this.tree, options).join('\n');
    }

    const lines = renderPath(this.tree, words, options);
    if (lines === null) return FortiMessages.unknownPath(words.join(' '));
    return lines.join('\n');
  }

  private get(rest: readonly string[]): string {
    if (rest.length === 0) {
      const object = this.nav.currentObject();
      if (object) return renderGet(this.tree, object.spec.path, object.key)?.join('\n') ?? '';
      const table = this.nav.currentTable();
      if (table) return renderGet(this.tree, table.spec.path)?.join('\n') ?? '';
      return FortiMessages.incomplete('a path');
    }

    const view = this.getView(rest);
    if (view !== null) return view;

    for (let take = Math.min(rest.length, 4); take >= 1; take--) {
      const path = rest.slice(0, take);
      if (!this.tree.spec(path)) continue;
      const key = rest[take] === undefined ? undefined : unquote(rest[take]);
      const lines = renderGet(this.tree, path, key);
      if (lines === null) return FortiMessages.unknownKey(key ?? '');
      return lines.join('\n');
    }
    return FortiMessages.unknownPath(rest.join(' '));
  }

  private getView(rest: readonly string[]): string | null {
    const path = rest.join(' ');

    if (path === 'system status') return this.systemStatus();
    if (path === 'system performance status') {
      return renderPerformanceStatus({
        sessions: this.fw.getSessionTable().view().statistics(),
        uptimeMs: this.fw.getUptimeMs(),
      });
    }
    if (path === 'system arp') return renderArpTable(this.fw.getArpService());
    if (path === 'system interface' || path === 'system interface physical') {
      return renderInterfaceStatus(this.fw.getInterfaceTable());
    }
    if (path === 'router info routing-table all') {
      return renderRoutingTable(this.fw.getRouteTable());
    }
    return null;
  }

  private systemStatus(): string {
    const settings = this.tree.setting('system settings', 'opmode')[0] ?? 'nat';
    const vdomMode = this.tree.setting('system global', 'vdom-mode')[0] ?? 'no-vdom';

    return renderSystemStatus({
      version: FORTIOS_PROFILE.defaultVersion,
      build: FORTI_BUILD,
      serial: this.serialNumber(),
      hostname: this.fw.getName(),
      operationMode: settings === 'transparent' ? 'Transparent' : 'NAT',
      vdom: this.vdom,
      maxVdoms: 10,
      vdomsInNat: settings === 'transparent' ? 0 : 1,
      vdomsInTransparent: settings === 'transparent' ? 1 : 0,
      vdomConfiguration: vdomMode === 'no-vdom' ? 'disable' : 'enable',
      haMode: 'standalone',
      systemTime: new Date(this.fw.now()).toUTCString(),
    });
  }

  private serialNumber(): string {
    const digits = this.fw.getName().split('').reduce(
      (total, letter) => (total * 31 + letter.charCodeAt(0)) % 100000000, 7);
    return `FGVMEV${String(digits).padStart(10, '0')}`;
  }

  private diagDeps() {
    return {
      fw: this.fw,
      state: this.diagnostics,
      vdom: () => this.vdom,
      logFormat: () => this.logFormat(),
      logContext: () => this.logContext(),
    };
  }

  private diagnose(rest: readonly string[]): string {
    return runDiagnose(rest, this.diagDeps());
  }

  private executeVerb(rest: readonly string[]): string {
    if (rest.length === 0) return FortiMessages.incomplete('a command');
    if (rest[0] === 'log') return runExecuteLog(rest.slice(1), this.diagDeps());
    return FortiMessages.commandFail(
      `\`execute ${rest[0]}\` is not implemented in this simulator.`,
    );
  }

  private logsImplicitDeny(): boolean {
    return this.tree.setting('log setting', 'fwpolicy-implicit-log')[0] === 'enable';
  }

  private logFormat(): FortiLogFormat {
    const declared = this.tree.setting('log syslogd', 'format')[0];
    if (declared === 'csv' || declared === 'cef' || declared === 'rfc5424') return declared;
    return 'default';
  }

  private logContext() {
    return {
      hostname: this.fw.getName(),
      serial: this.serialNumber(),
      version: FORTIOS_PROFILE.defaultVersion,
      facility: 23,
    };
  }

  private describe(suggestions: readonly Suggestion[]): readonly string[] {
    if (suggestions.length === 0) return [];
    const width = Math.max(20, ...suggestions.map(s => s.value.length + 2));
    return renderTable(suggestions, [
      { header: '', width, value: s => s.value },
      { header: '', width: 0, value: s => s.description },
    ], FIXED_TABLE).slice(1);
  }

  setHints(enabled: boolean): void {
    setHintsEnabled(enabled);
  }
}

export function vipRuleId(name: string): string {
  return `vip:${name}`;
}

export function centralSnatRuleId(id: string): string {
  return `csnat:${id}`;
}

function applyVipToFirewall(fw: Firewall, vip: FortiVipPatch): void {
  const interfaces = vip.externalInterfaces.filter(name => name !== 'any');

  fw.getNatPolicy().upsert({
    id: vipRuleId(vip.name),
    type: 'static',
    name: vip.name,
    fromZone: interfaces.length > 0 ? [...interfaces] : ['any'],
    originalSource: vip.sourceFilters.length > 0 ? [...vip.sourceFilters] : ['any'],
    originalDestination: [vip.externalAddress],
    originalPort: vip.portForward
      ? {
        protocol: vip.protocol,
        from: vip.externalPortFrom,
        to: vip.externalPortTo === 0 ? vip.externalPortFrom : vip.externalPortTo,
      }
      : undefined,
    destinationTranslation: {
      kind: 'static-ip',
      translatedAddress: vip.mappedAddress,
      translatedEndAddress: vip.mappedEndAddress,
      translatedPort: vip.portForward && vip.mappedPort > 0 ? vip.mappedPort : undefined,
    },
    comment: vip.comment,
  });

  fw.getObjectStore().upsertAddress(
    vipAddress(vip.name, vip.mappedAddress, vipRuleId(vip.name), vip.mappedEndAddress));

  const owner = proxyOwnerKey('vip', vip.name);
  if (!vip.arpReply) { fw.clearProxyArpEntries(owner); return; }

  fw.setProxyArpEntries(owner, interfaces.length === 0
    ? [{ from: vip.externalAddress, to: vip.externalEndAddress }]
    : interfaces.map(iface => ({
      from: vip.externalAddress, to: vip.externalEndAddress, iface,
    })));
}

function applyCentralSnatToFirewall(fw: Firewall, entry: FortiCentralSnatPatch): void {
  fw.getNatPolicy().upsert({
    id: centralSnatRuleId(entry.id),
    type: entry.translate ? 'dynamic-pat' : 'no-nat',
    enabled: entry.enabled,
    fromZone: listOrAny(entry.sourceInterfaces),
    toZone: listOrAny(entry.destinationInterfaces),
    originalSource: listOrAny(entry.originalAddresses),
    originalDestination: listOrAny(entry.destinationAddresses),
    sourcePort: entry.sourcePortFrom > 0
      ? {
        protocol: entry.protocol,
        from: entry.sourcePortFrom,
        to: entry.sourcePortTo === 0 ? entry.sourcePortFrom : entry.sourcePortTo,
      }
      : undefined,
    noTranslation: !entry.translate,
    sourceTranslation: entry.translate
      ? {
        kind: 'dynamic-ip-and-port',
        pool: entry.pool,
        fallbackToInterface: entry.pool === undefined,
        translatedPortFrom: entry.translatedPortFrom,
        translatedPortTo: entry.translatedPortTo,
      }
      : undefined,
    comment: entry.comment,
  }, entry.position);
}

function listOrAny(values: readonly string[]): string[] {
  const cleaned = values.filter(value => value !== 'any' && value !== 'all');
  return cleaned.length > 0 ? cleaned : ['any'];
}

function toPrefix(raw: string): PolicyRoutePrefix | null {
  const [network, length] = raw.split('/');
  if (network === undefined) return null;
  if (length === undefined) return { network, mask: '255.255.255.255' };

  const bits = Number.parseInt(length, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return null;
  return { network, mask: maskOfLength(bits) };
}

function isPrefix(value: PolicyRoutePrefix | null): value is PolicyRoutePrefix {
  return value !== null;
}

function maskOfLength(bits: number): string {
  const value = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.');
}

function helpPrefix(input: string): string {
  return input.replace(/^\s+/, '');
}

function splitTokens(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (const character of line) {
    if (character === '"') { quoted = !quoted; current += character; continue; }
    if (!quoted && /\s/.test(character)) {
      if (current.length > 0) { out.push(current); current = ''; }
      continue;
    }
    current += character;
  }
  if (current.length > 0) out.push(current);
  return out;
}
