import { renderTable, FIXED_TABLE } from '../../../shells/cli/TextTable';
import type { EnumValue } from '../../../../../cli/ArgumentTypes';
import type { Suggestion } from '../../../../../cli/CompletionEngine';
import type { FortiGate } from './FortiGate';
import { FORTIOS_PROFILE } from './FortiProfile';
import { FortiMessages, FORTI_COMMAND_FAIL, setHintsEnabled } from './FortiMessages';
import { FortiSocle } from './FortiSocle';
import { schemaIndex } from './schema';
import type {
  FortiCommitContext, FortiCommitDevice, FortiTableSpec,
} from './schema/types';
import type { AccessIntent, AccessVerdict } from '../../authz/AccessMatrix';
import { FortiConfigTree } from './runtime/FortiConfigTree';
import { FortiNavigator, unquote } from './runtime/FortiNavigator';
import { FortiValidator } from './runtime/FortiValidator';
import { renderPath, renderWholeConfig } from './render/showRenderer';
import { renderGet } from './render/getRenderer';
import { buildCommitDevice } from './runtime/commitDevice';
import { vipAddress } from '../../model/AddressObject';
import type { Firewall } from '../../Firewall';
import { identityCommitHandlers } from './commit/identityCommits';
import { vpnCommitHandlers } from './commit/vpnCommits';
import {
  applyCentralSnatToFirewall, applyVipToFirewall, categoryEntry, centralSnatRuleId,
  filterTable, urlEntry, utmAction, vipRuleId,
} from './commit/objectCommits';
import type { PolicyRoutePrefix } from '../../l3/PolicyRouteTable';
import type {
  FortiCategoryFilterPatch, FortiCentralSnatPatch, FortiFilterTablePatch,
  FortiUrlFilterPatch, FortiVipPatch,
} from './schema/types';
import type {
  CategoryFilterEntry, FilterTable, UrlFilterEntry, UtmAction,
} from '../../inspection/UtmProfiles';
import { FortiDiagnostics } from './diag/FortiDiagnostics';
import { deniedLog, runDiagnose, runExecuteLog } from './diag/FortiDiagCommands';
import {
  renderArpTable, renderInterfaceStatus, renderPerformanceStatus,
  renderBgpNeighbors, renderBgpSummary, renderDhcpLeases,
  renderOspfNeighbors, renderRoutingTable, renderSystemStatus,
} from './diag/getViews';
import { renderHaChecksum, renderHaStatus } from './diag/haRenderer';
import type { FortiLogFormat } from './log/fortiLogFormat';
import {
  shouldLogTraffic, shouldLogTrafficStart, trafficCloseLog, trafficStartLog,
} from './log/trafficLog';

export { FORTI_COMMAND_FAIL };

export const FORTI_BUILD = '2662';

const PER_MEMBER_LINE = /^set (priority|hostname)\b/;

export class FortiShell {
  private readonly tree: FortiConfigTree;
  private readonly nav: FortiNavigator;
  private readonly socle: FortiSocle;
  private readonly diagnostics = new FortiDiagnostics();
  private vdom = 'root';
  private adminName: string | null = null;
  private globalScope = false;

  constructor(private readonly fw: FortiGate) {
    this.tree = new FortiConfigTree(schemaIndex());
    this.tree.bindScope(() => this.vdom);
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
      enterGlobal: () => this.enterGlobal(),
      authorize: (spec, intent) => this.authorizeSpec(spec, intent),
      principal: () => this.adminName ?? '',
    });
    this.fw.bindHaConfiguration(
      () => this.clusterConfigurationText(),
      (text) => { this.absorbClusterConfiguration(text); });
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

  private clusterConfigurationText(): string {
    const kept: string[] = [];
    let insideHa = false;

    for (const line of renderWholeConfig(this.tree, { full: false })) {
      const trimmed = line.trim();
      if (trimmed === 'config system ha') { insideHa = true; continue; }
      if (insideHa) { if (trimmed === 'end') insideHa = false; continue; }
      if (PER_MEMBER_LINE.test(trimmed)) continue;
      kept.push(line);
    }
    return kept.join('\n');
  }

  private absorbClusterConfiguration(text: string): void {
    if (text.length === 0) return;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.socle.execute(trimmed);
    }
  }

  getPrompt(): string {
    const host = this.fw.getName();
    const label = this.nav.label();
    if (label !== null) return `${host} (${label}) # `;
    return this.globalScope ? `${host} (global) # ` : `${host} # `;
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
    const text = outcome.handled ? outcome.output : this.refusal(line);
    this.syncActiveVdom();
    return text;
  }

  setAdminIdentity(name: string | null): void {
    this.adminName = name;
  }

  getAdminIdentity(): string | null { return this.adminName; }

  private authorizeSpec(spec: FortiTableSpec, intent: AccessIntent): AccessVerdict {
    if (this.adminName === null) return 'run';

    const admin = this.fw.getAccessMatrix().getAdmin(this.adminName);
    if (!admin) return 'absent';

    return this.fw.getAccessMatrix().authorize(admin.profile, spec.accessGroup, intent);
  }

  private enterGlobal(): string {
    if (!this.fw.multiVdomEnabled()) {
      return FortiMessages.commandFail(
        '`config global` only exists once `set vdom-mode multi-vdom` is applied.');
    }

    this.nav.abortToRoot();
    this.globalScope = true;
    this.fw.setActiveVdom('root');
    return '';
  }

  private syncActiveVdom(): void {
    let active = 'root';
    for (const frame of this.nav.frames()) {
      if (frame.kind !== 'object') continue;
      if (frame.object.spec.path.join(' ') !== 'vdom') continue;
      active = frame.object.key;
    }

    if (active !== 'root') this.globalScope = false;
    this.vdom = active;
    this.fw.setActiveVdom(active);
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
    return buildCommitDevice(this.fw);
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
        for (const name of this.fw.getTunnelTable().phase1Names()) {
          if (this.fw.getTunnelTable().isTunnelInterface(name)) {
            push(name, 'IPsec tunnel interface.');
          }
        }
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
    if (path === 'system ha status') {
      return renderHaStatus(this.fw.getHa(), {
        model: 'FortiGate-VM64',
        hostname: this.fw.getName(),
        now: this.fw.now(),
      });
    }
    if (path === 'system interface' || path === 'system interface physical') {
      return renderInterfaceStatus(this.fw.getInterfaceTable());
    }
    if (path === 'router info ospf neighbor') {
      return renderOspfNeighbors(this.fw.getRouting().ospfNeighbors());
    }
    if (path === 'router info routing-table all') {
      return renderRoutingTable(this.fw.getRouteTable());
    }
    if (path === 'router info bgp summary') {
      return renderBgpSummary(this.fw.getRouting().getBgp().summaryFacts());
    }
    if (path === 'router info bgp neighbors') {
      return renderBgpNeighbors(this.fw.getRouting().getBgp().summaryFacts());
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

  private serialNumber(): string { return this.fw.serialNumber(); }

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
    if (rest[0] === 'ha') return this.executeHa(rest.slice(1));
    if (rest[0] === 'dhcp' && rest[1] === 'lease-list') {
      return renderDhcpLeases(this.fw.getDhcp().leases());
    }
    return FortiMessages.commandFail(
      `\`execute ${rest[0]}\` is not implemented in this simulator.`,
    );
  }

  private executeHa(rest: readonly string[]): string {
    const ha = this.fw.getHa();
    if (ha.getConfiguration().mode === 'standalone') {
      return FortiMessages.commandFail('this unit is not part of a cluster.');
    }

    if (rest[0] === 'failover' && rest[1] === 'set') { ha.forceFailover(); return ''; }
    if (rest[0] === 'manage') {
      const index = Number.parseInt(rest[1] ?? '', 10);
      const peers = ha.knownPeers();
      if (!Number.isFinite(index) || index < 1 || index > peers.length) {
        return FortiMessages.commandFail(`no cluster member ${rest[1] ?? ''}.`);
      }
      return `Connecting to ${peers[index - 1].serial}...`;
    }
    return FortiMessages.unknownPath(`ha ${rest.join(' ')}`);
  }

  private logsImplicitDeny(): boolean {
    return this.tree.setting('log setting', 'fwpolicy-implicit-log')[0] === 'enable';
  }

  private logFormat(): FortiLogFormat {
    const declared = this.tree.setting('log syslogd setting', 'format')[0];
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
