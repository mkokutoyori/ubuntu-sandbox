import { renderTable, FIXED_TABLE } from '../../../shells/cli/TextTable';
import type { EnumValue } from '../../../../../cli/ArgumentTypes';
import type { Suggestion, CompletionTrigger } from '../../../../../cli/CompletionEngine';
import type { FortiGate } from './FortiGate';
import { FORTIOS_PROFILE } from './FortiProfile';
import type { PingOptions } from '../../diag/PingOptions';
import {
  FortiMessages, FORTI_COMMAND_FAIL, setHintsEnabled,
} from './FortiMessages';
import {
  fortiSystemTime, runExecuteDate, runExecuteTime,
} from './diag/timeCommands';
import { applyFilter, splitPipe } from './render/outputFilter';
import {
  FortiSocle, FORTI_TOKENS, VALUE_LIST_VERBS, branchHelp, existingEntryHelp,
} from './FortiSocle';
import type { CommandInteractionPlan } from '../../../../../shell/interaction/CommandInteraction';
import { schemaIndex } from './schema';
import type {
  FortiCommitContext, FortiCommitDevice, FortiTableSpec,
} from './schema/types';
import type { AccessIntent, AccessVerdict } from '../../authz/AccessMatrix';
import { FortiConfigTree } from './runtime/FortiConfigTree';
import {
  FortiNavigator, unquote, type FortiConfigChange,
} from './runtime/FortiNavigator';
import { executeNames, resolvePrefix } from './execute/executeVocabulary';
import {
  FORTI_GET_VIEWS, resolvePathWords, viewContinuations,
} from './view/pathResolution';
import { FortiValidator } from './runtime/FortiValidator';
import { renderPath, renderWholeConfig } from './render/showRenderer';
import { renderRevisionList } from './render/revisionRenderer';
import { renderIpv6RoutingTable } from './diag/ipv6Renderers';
import { renderGet } from './render/getRenderer';
import { buildCommitDevice } from './runtime/commitDevice';
import { vipAddress } from '../../model/AddressObject';
import { Firewall } from '../../Firewall';
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
import {
  deniedLog, runDiagnose, runExecuteLog, parseSnifferPlan, type SnifferPlan,
} from './diag/FortiDiagCommands';
import { renderVpnTunnelList, renderVpnTunnelSummary } from './diag/vpnTunnelRenderer';
import {
  renderArpTable, renderInterfaceStatus, renderPerformanceStatus,
  type InterfaceStatusFacts,
  renderBgpNeighbors, renderBgpSummary, renderDhcpLeases,
  renderOspfNeighbors, renderRoutingTable, renderSystemStatus,
} from './diag/getViews';
import { renderHaChecksum, renderHaStatus } from './diag/haRenderer';
import type { FortiLogFormat } from './log/fortiLogFormat';
import {
  configChangeLog,
  shouldLogTraffic, shouldLogTrafficStart, trafficCloseLog, trafficStartLog,
} from './log/trafficLog';
import { utmLog } from './log/utmLog';
import { renderFortiguardServiceStatus } from './diag/fortiguardRenderer';
import type { FortiGuardFamily } from '../../mgmt/FortiGuardDatabases';
import { TftpClientSession } from '@/network/tftp/TftpSession';
import { IPAddress } from '@/network/core/types';
import { tokenize } from '@/cli/CommandParser';
import { encryptConfig, decryptConfig, isEncryptedConfig } from './backup/ConfigEncryption';
import {
  renderOspfDatabase, renderOspfInterfaces,
} from './diag/ospfDatabaseRenderer';
import type { OspfInterfaceFacts } from '../../routing/DynamicRoutingTypes';

const OSPF_NOT_RUNNING = '';

function outsideOspf(name: string, physical: boolean): OspfInterfaceFacts {
  return {
    name, up: physical, ifindex: 0, mtu: 1500, bandwidthMbit: 1000, enabled: false,
    areaId: '0.0.0.0', routerId: '0.0.0.0', networkType: 'BROADCAST', cost: 0,
    transmitDelay: 1, state: 'Down', priority: 1,
    helloInterval: 10, deadInterval: 40, retransmitInterval: 5,
    passive: false, neighbourCount: 0, adjacentCount: 0,
  };
}

export { FORTI_COMMAND_FAIL };

export const FORTI_BUILD = '2660';

const PER_MEMBER_LINE = /^set (priority|hostname)\b/;

const DEFAULT_ADMINISTRATIVE_INTERFACE = 'jsconsole';

interface HaPendingLogin {
  readonly serial: string;
  readonly hostname: string;
  readonly admin: string;
}

interface HaRemoteSession extends HaPendingLogin {
  readonly token: string;
}

const FORTIGUARD_UNREACHABLE =
  'Objects updated: 0\nFortiGuard Distribution Network is not reachable.';

const NO_PING_PAYLOAD = 'an echo request carries no operator-chosen payload here — '
  + 'its data field is a byte count, not bytes — so a pattern could be set and never '
  + 'sent, and a reply could never be checked against it.';

const UNSIMULATED_PING_OPTIONS: Readonly<Record<string, string>> = {
  pattern: NO_PING_PAYLOAD,
  'validate-reply': NO_PING_PAYLOAD,
  'adaptive-ping': 'frames are delivered synchronously, with no wire clock, so there '
    + 'is no round-trip time for the interval to adapt to.',
};

const TFTP_EXPORT_TIMEOUT_MS = 1_000;
const TFTP_EXPORT_MAX_RETRIES = 2;

function annonceAlimentation(action: 'reboot' | 'shutdown' | 'factoryreset'): string {
  return action === 'factoryreset'
    ? 'This operation will reset the system to factory default!'
    : `This operation will ${action} the system !`;
}

export class FortiShell {
  private pendingAsync: Promise<string> | null = null;

  takePendingAsync(): Promise<string> | null {
    const pending = this.pendingAsync;
    this.pendingAsync = null;
    return pending;
  }

  private readonly tree: FortiConfigTree;
  private readonly nav: FortiNavigator;
  private readonly socle: FortiSocle;
  private readonly diagnostics = new FortiDiagnostics();
  private seedFactoryCertificates(): void {
    const spec = this.tree.spec(['vpn', 'certificate', 'local']);
    if (!spec) return;
    const table = this.tree.table(spec);
    for (const name of this.fw.getCertificateStore().localNames()) {
      const entry = this.fw.getCertificateStore().local(name);
      if (!entry || entry.source !== 'factory') continue;
      const object = table.ensure(name);
      object.set('certificate', [entry.certificatePem]);
      object.set('private-key', [entry.privateKeyPem]);
      object.set('source', ['factory']);
    }
  }

  private seedFactoryAdmin(): void {
    const spec = this.tree.spec(['system', 'admin']);
    if (!spec) return;
    const table = this.tree.table(spec);
    for (const name of this.fw.adminNames()) {
      const admin = this.fw.getAdminAccount(name);
      if (!admin) continue;
      const object = table.ensure(name);
      object.set('accprofile', [admin.profile]);
    }
  }

  private seedFactoryVdoms(): void {
    const spec = this.tree.spec(['vdom']);
    if (!spec) return;
    const table = this.tree.table(spec);
    for (const name of this.fw.vdomNames()) table.ensure(name);
  }

  private vdom = 'root';
  private adminName: string | null = null;
  private globalScope = false;
  private enteredVdom = 'root';
  private haRemote: HaRemoteSession | null = null;
  private haPendingLogin: HaPendingLogin | null = null;
  private continuation: string | null = null;

  private claimTree(): void {
    this.tree.bindScope(() => this.vdom);
  }

  constructor(private readonly fw: FortiGate) {
    this.tree = fw.configTree();
    this.claimTree();
    this.tree.bindPhysicalPorts((name) => this.fw.isPhysicalPort(name));
    this.seedFactoryCertificates();
    this.seedFactoryAdmin();
    this.seedFactoryVdoms();
    const validator = new FortiValidator(
      (target, name) => this.referenceExists(target, name), this.tree);
    this.nav = new FortiNavigator({
      tree: this.tree,
      validator,
      commitContext: () => this.commitContext(),
      onConfigured: (change) => {
        this.logConfigurationChange(change);
        this.fw.refreshLiveState();
      },
      expandVariables: (value) => this.expandVariables(value),
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
      leaveCli: () => '',
      enterGlobal: () => this.enterGlobal(),
      authorize: (spec, intent) => this.authorizeSpec(spec, intent),
      principal: () => this.adminName ?? '',
      vdomNames: () => this.fw.vdomNames(),
      enterVdom: (name) => this.enterVdom(name),
      adminSessions: () => this.fw.getAdminSessions().list(),
      disconnectAdminSession: (index) => this.disconnectAdminSession(index),
    });
    this.fw.bindConfigSnapshot(
      () => renderWholeConfig(this.tree, { full: false }).join('\n'));
    this.fw.bindHaConfiguration(
      () => this.clusterConfigurationText(),
      (text) => { this.absorbClusterConfiguration(text); });
    this.fw.setTrafficLogger({
      onSessionOpened: (session, rule) => {
        if (!shouldLogTrafficStart(rule)) return;
        this.fw.getLogStore().append(trafficStartLog({
          session, rule, now: this.fw.now(),
          identity: this.loggedIdentity(session.c2s.sourceIP),
        }));
      },
      onSessionClosed: (session, reason) => {
        const rule = session.policyId === undefined
          ? undefined
          : this.fw.getPolicyStore().byId(session.policyId);
        if (!shouldLogTraffic(rule)) return;
        this.fw.getLogStore().append(trafficCloseLog({
          session, rule, now: this.fw.now(),
          identity: this.loggedIdentity(session.c2s.sourceIP),
        }, reason));
      },
      onDenied: (context) => {
        const utm = context.utmVerdict === undefined
          ? undefined : utmLog(context, context.utmVerdict, this.fw.now());
        if (utm) { this.fw.getLogStore().append(utm); return; }
        const rule = context.matchedPolicy;
        if (rule?.implicit === true && !this.logsImplicitDeny()) return;
        if (rule !== undefined && rule.implicit === false
          && !shouldLogTraffic(rule)) return;
        this.fw.getLogStore().append(deniedLog(
          context, this.fw.now(),
          this.loggedIdentity((context.originalPacket as { sourceIP: { toString(): string } })
            .sourceIP.toString())));
      },
    });
    this.seedChassisInterfaces();
  }

  private seedChassisInterfaces(): void {
    const spec = this.tree.spec(['system', 'interface']);
    if (!spec) return;
    const table = this.tree.table(spec);

    for (const port of Firewall.chassisPorts(this.fw.getProfile())) {
      if (table.has(port.name)) continue;
      const entry = table.ensure(port.name);
      entry.set('name', [port.name]);
      entry.set('vdom', ['root']);
      entry.set('type', ['physical']);
      entry.set('role', [port.role]);
      if (port.ip) entry.set('ip', [port.ip, port.mask ?? '255.255.255.0']);
      if (port.allowaccess) entry.set('allowaccess', [...port.allowaccess]);
    }
  }

  private loggedIdentity(address: string) {
    const identity = this.fw.getIdentityTable().lookup(address);
    if (!identity) return undefined;
    return {
      user: identity.user,
      groups: identity.groups,
      source: identity.source,
      server: identity.server,
    };
  }

  private clusterConfigurationText(): string {
    const kept: string[] = [];
    let insideHa = false;
    let insideLocalCertificates = false;
    let entry: string[] | null = null;

    for (const line of renderWholeConfig(this.tree, { full: false })) {
      const trimmed = line.trim();
      if (trimmed === 'config system ha') { insideHa = true; continue; }
      if (insideHa) { if (trimmed === 'end') insideHa = false; continue; }
      if (PER_MEMBER_LINE.test(trimmed)) continue;

      if (trimmed === 'config vpn certificate local') {
        insideLocalCertificates = true;
        kept.push(line);
        continue;
      }
      if (insideLocalCertificates) {
        if (entry === null && trimmed.startsWith('edit ')) { entry = [line]; continue; }
        if (entry !== null) {
          entry.push(line);
          if (trimmed === 'next') {
            if (!entry.some(row => row.trim() === 'set source factory')) kept.push(...entry);
            entry = null;
          }
          continue;
        }
        if (trimmed === 'end') insideLocalCertificates = false;
      }
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
    if (this.haPendingLogin !== null) return `${this.haPendingLogin.hostname} password: `;
    if (this.haRemote !== null) return `${this.haRemote.hostname} # `;
    const host = this.fw.getName();
    const label = this.nav.label();
    if (label !== null) return `${host} (${label}) # `;
    if (this.globalScope) return `${host} (global) # `;
    return this.vdom === 'root' ? `${host} # ` : `${host} (${this.vdom}) # `;
  }

  getConfigTree(): FortiConfigTree {
    return this.tree;
  }

  private candidates(input: string, trigger: CompletionTrigger): readonly Suggestion[] {
    const prefix = input.trimStart();
    const head = prefix.slice(0, prefix.lastIndexOf(' ') + 1);
    const typed = prefix.slice(head.length);
    const bare = typed.startsWith('"') ? typed.slice(1) : typed;

    const out: Suggestion[] = [];
    const seen = new Set<string>();
    for (const suggestion of [
      ...this.socle.suggestions(this.socleProbe(head, bare), trigger),
      ...this.viewPathSuggestions(head, bare),
    ]) {
      if (seen.has(suggestion.value)) continue;
      seen.add(suggestion.value);
      out.push(suggestion);
    }
    return out;
  }

  completions(input: string): readonly string[] {
    this.claimTree();
    const prefix = input.trimStart();
    const head = prefix.slice(0, prefix.lastIndexOf(' ') + 1);
    const typed = prefix.slice(head.length);
    const quote = typed.startsWith('"') ? '"' : '';
    const bare = typed.slice(quote.length);

    const developpee = this.canonicalHead(head);
    const lowered = bare.toLowerCase();
    return this.candidates(input, 'TAB')
      .filter(s => !s.isArgument || s.completable === true)
      .map(s => s.value)
      .filter(value => value.toLowerCase().startsWith(lowered)
        && value.toLowerCase() !== lowered)
      .map(value => `${developpee}${quote}${value}${quote}`);
  }

  private canonicalHead(head: string): string {
    const words = this.canonicalWords(head);
    return words.length === 0 ? head : `${words.join(' ')} `;
  }

  private canonicalWords(head: string): readonly string[] {
    const typed = head.trim().split(/\s+/).filter(Boolean);
    if (typed.length === 0) return [];

    const words = [...this.socle.canonicalWords(typed)];
    if (words[0] !== 'show' && words[0] !== 'get') return words;

    const resolution = resolvePathWords(words.slice(1), (prefix) => [
      ...this.tree.branchNames(prefix),
      ...viewContinuations(FORTI_GET_VIEWS, prefix),
    ]);
    return [words[0], ...resolution.words];
  }

  private socleProbe(head: string, typed: string): string {
    const words = head.trim().split(/\s+/).filter(Boolean);
    if (words.length > 2 && VALUE_LIST_VERBS.includes(words[0] as never)
      && this.acceptsSeveralValues(words[1])) {
      return `${words[0]} ${words[1]} ${typed}`;
    }
    return `${head}${typed}`;
  }

  private acceptsSeveralValues(attribute: string): boolean {
    const object = this.nav.currentObject();
    if (!object) return false;
    return object.spec.attributes
      .some(spec => spec.name === attribute && spec.multiValue === true);
  }

  private viewPathSuggestions(head: string, typed: string): readonly Suggestion[] {
    const words = this.canonicalWords(head);
    if (words[0] !== 'show' && words[0] !== 'get') return [];

    const walked = words.slice(1);
    const lowered = typed.toLowerCase();
    const retenu = (value: string) => value.toLowerCase().startsWith(lowered);
    const proposition = (value: string, description: string): Suggestion =>
      ({ value, description, isArgument: true, completable: true });

    const branches = [...new Set([
      ...this.tree.branchNames(walked),
      ...(words[0] === 'get' ? viewContinuations(FORTI_GET_VIEWS, walked) : []),
    ])].sort();
    if (branches.length > 0) {
      return branches.filter(retenu).map(word =>
        proposition(word, branchHelp(this.tree.spec([...walked, word]), word)));
    }

    const spec = this.tree.spec(walked);
    if (!spec || spec.kind !== 'table') return [];
    return this.tree.table(spec).keys().filter(retenu)
      .map(key => proposition(key, existingEntryHelp(key)));
  }

  help(inputBeforeQuestion = ''): readonly string[] {
    this.claimTree();
    return this.describe(
      this.candidates(helpPrefix(inputBeforeQuestion), 'QUESTION_MARK'));
  }

  abortContinuation(): boolean {
    if (this.continuation === null) return false;
    this.continuation = null;
    return true;
  }

  execute(rawLine: string): string {
    this.claimTree();
    if (this.continuation !== null) {
      const merged = joinContinuation(this.continuation, rawLine);
      if (stillOpen(merged)) { this.continuation = merged; return ''; }
      this.continuation = null;
      return this.execute(merged);
    }
    if (stillOpen(rawLine)) {
      this.continuation = rawLine;
      return '';
    }

    const piped = splitPipe(rawLine.trim());
    if (piped.error !== null) return piped.error;
    if (piped.filter === null) return this.runLine(piped.command);
    return applyFilter(this.runLine(piped.command), piped.filter);
  }

  private runLine(line: string): string {
    if (this.haPendingLogin !== null) return this.finishHaLogin(line);
    if (this.haRemote !== null) return this.relayToHaPeer(line);
    if (line.length === 0) return '';
    if (line.endsWith('?')) {
      return this.help(line.slice(0, -1)).join('\n');
    }

    if (/^write\b/.test(line)) return FortiMessages.noSaveNeeded();
    if (/^show\s+full-configuration\b/.test(line)) {
      return this.show(tokenize(line, FORTI_TOKENS).slice(2), true);
    }

    const outcome = this.socle.execute(line);
    const text = outcome.handled ? outcome.output : this.refusal(line);
    this.syncActiveVdom();
    return text;
  }

  private expandVariables(value: string): string {
    return value
      .split('$SerialNum').join(this.fw.serialNumber())
      .split('$USERNAME').join(this.adminName ?? '')
      .split('$USERFROM').join(this.administrativeInterface());
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

  private motInconnu(tokens: readonly string[]): string {
    if (tokens.length <= 1) return tokens[0] ?? '';
    return this.socle.suggestions(`${tokens[0]} `, 'QUESTION_MARK').length === 0
      ? tokens[0] : tokens.join(' ');
  }

  private leaveOneLevel(): string {
    if (this.nav.frames().length === 0 && this.globalScope) {
      this.globalScope = false;
      return '';
    }
    return this.nav.end();
  }

  beginConsoleSession(): void {
    this.nav.abort();
    this.globalScope = false;
    this.fw.setActiveVdom('root');
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
    let active = this.enteredVdom;
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
    const tokens = tokenize(line, FORTI_TOKENS);
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
    if (tokens[0] === 'end') return this.leaveOneLevel();

    return FortiMessages.unknownCommand(this.motInconnu(tokens));
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
      localIn: this.fw.getLocalInPolicy(),
      objects: this.fw.getObjectStore(),
      device: this.commitDevice(),
      vdom: this.vdom,
      position: -1,
    };
  }

  private commitDevice(): FortiCommitDevice {
    return buildCommitDevice(this.fw, this.tree);
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
    const typed = rest[0] === 'full-configuration' ? rest.slice(1) : rest;
    const options = { full: full || rest[0] === 'full-configuration' };

    const resolution = resolvePathWords(typed, (prefix) => this.tree.branchNames(prefix));
    if (resolution.ambiguous) {
      return FortiMessages.ambiguous(
        resolution.ambiguous.typed, resolution.ambiguous.candidates);
    }
    const words = resolution.words;

    if (words.length === 0) {
      const object = this.nav.currentObject();
      if (object) {
        return (renderPath(this.tree, object.spec.path, options) ?? []).join('\n');
      }
      const table = this.nav.currentTable();
      if (table) return (renderPath(this.tree, table.spec.path, options) ?? []).join('\n');
      return renderWholeConfig(this.tree, options).join('\n');
    }

    for (let take = Math.min(words.length, 4); take >= 1; take--) {
      const path = words.slice(0, take);
      if (!this.tree.spec(path)) continue;
      const key = words[take] === undefined ? undefined : unquote(words[take]);
      const lines = renderPath(this.tree, path, options, key);
      if (lines === null) return FortiMessages.unknownKey(key ?? '');
      return lines.join('\n');
    }
    return FortiMessages.unknownPath(words.join(' '), 'show');
  }

  private get(typed: readonly string[]): string {
    if (typed.length === 0) {
      const object = this.nav.currentObject();
      if (object) return renderGet(this.tree, object.spec.path, object.key)?.join('\n') ?? '';
      const table = this.nav.currentTable();
      if (table) return renderGet(this.tree, table.spec.path)?.join('\n') ?? '';
      return FortiMessages.incomplete('a path');
    }

    const resolution = resolvePathWords(typed, (prefix) => [
      ...this.tree.branchNames(prefix),
      ...viewContinuations(FORTI_GET_VIEWS, prefix),
    ]);
    if (resolution.ambiguous) {
      return FortiMessages.ambiguous(
        resolution.ambiguous.typed, resolution.ambiguous.candidates);
    }
    const rest = resolution.words;

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
    return FortiMessages.unknownPath(rest.join(' '), 'get');
  }

  private getView(rest: readonly string[]): string | null {
    const path = rest.join(' ');

    if (path === 'system status') return this.systemStatus();
    if (path === 'system performance status') {
      return renderPerformanceStatus({
        load: this.fw.getSystemLoad(),
        uptimeMs: this.fw.getUptimeMs(),
      });
    }

    if (path === 'vpn ipsec tunnel summary') {
      return renderVpnTunnelSummary(this.fw.getTunnelTable());
    }
    if (path === 'vpn ipsec tunnel details' || path === 'vpn ipsec tunnel name') {
      return renderVpnTunnelList(this.fw.getTunnelTable(), this.fw.now());
    }
    if (path === 'system fortiguard-service status') {
      return renderFortiguardServiceStatus();
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
      return renderInterfaceStatus(
        this.interfaceStatusFacts(), path.endsWith('physical'));
    }
    if (path === 'router info ospf neighbor') {
      return renderOspfNeighbors(this.fw.getRouting().ospfNeighbors());
    }
    if (path === 'router info ospf database' || path === 'router info ospf database brief') {
      const facts = this.fw.getRouting().ospfDatabase();
      return facts === null ? OSPF_NOT_RUNNING : renderOspfDatabase(facts);
    }
    if (path === 'router info ospf interface' || path.startsWith('router info ospf interface ')) {
      return this.ospfInterfaceView(path.slice('router info ospf interface'.length).trim());
    }
    if (path.startsWith('router info routing-table ')) {
      const view = path.slice('router info routing-table '.length);
      if (view !== 'all' && view !== 'static' && view !== 'connected'
        && view !== 'database' && view !== 'ospf' && view !== 'rip'
        && view !== 'bgp') return null;
      return renderRoutingTable(this.fw.getRouteTable(), view);
    }
    if (path === 'router info6 routing-table') {
      return renderIpv6RoutingTable(this.fw.getIpv6().dataPlane().getRoutingTable());
    }
    if (path === 'router info bgp summary') {
      return renderBgpSummary(this.fw.getRouting().getBgp().summaryFacts());
    }
    if (path === 'router info bgp neighbors') {
      return renderBgpNeighbors(this.fw.getRouting().getBgp().summaryFacts());
    }
    return null;
  }

  private ospfInterfaceView(name: string): string | null {
    const declared = this.fw.getRouting().ospfInterfaces();
    if (name.length === 0) {
      return declared.length === 0 ? OSPF_NOT_RUNNING : renderOspfInterfaces(declared);
    }

    const wanted = unquote(name);
    const found = declared.find(iface => iface.name === wanted);
    if (found) return renderOspfInterfaces([found]);
    if (this.fw.getPort(wanted) === undefined
      && this.fw.listL3Interfaces().every(iface => iface.name !== wanted)) return null;

    return renderOspfInterfaces([outsideOspf(wanted, this.fw.getPort(wanted) !== undefined)]);
  }

  private interfaceStatusFacts(): InterfaceStatusFacts[] {
    return this.fw.listL3Interfaces().map((iface) => {
      const port = this.fw.getPort(iface.name);
      const linked = port !== undefined && port.isConnected() && port.isOperationallyUp();
      return {
        name: iface.name,
        mode: this.interfaceSetting(iface.name, 'mode') ?? 'static',
        ip: `${iface.ip ?? '0.0.0.0'} ${iface.mask ?? '0.0.0.0'}`,
        ipv6: '::/0',
        status: iface.up ? 'up' : 'down',
        speed: linked && port !== undefined
          ? `${port.getNegotiatedSpeed()}Mbps (Duplex: ${port.getNegotiatedDuplex()})`
          : 'n/a',
        physical: port !== undefined,
      };
    });
  }

  private interfaceSetting(name: string, attribute: string): string | undefined {
    const spec = this.tree.spec(['system', 'interface']);
    if (!spec) return undefined;
    return this.tree.table(spec).get(name)?.effective(attribute)[0];
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
      haMode: this.fw.getHa().getConfiguration().mode === 'standalone'
        ? 'standalone' : this.fw.getHa().getConfiguration().mode,
      licenseStatus: 'Valid',
      vmCpus: this.fw.getSystemLoad().cpuCount(),
      vmMemoryMb: Math.round(this.fw.getSystemLoad().memory().totalKib / 1024),
      logDisk: 'Available',
      systemTime: fortiSystemTime(this.fw),
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
      configTree: () => this.tree,
    };
  }

  private diagnose(rest: readonly string[]): string {
    return runDiagnose(rest, this.diagDeps());
  }

  private tftpTarget(
    destination: string | undefined, server: string | undefined,
  ): IPAddress | string {
    if (destination === undefined) return FortiMessages.incomplete('a destination');
    if (destination !== 'tftp') {
      return FortiMessages.commandFail(
        `destination "${destination}" is not available; this unit has no USB port `
        + 'and no FTP client.');
    }
    if (server === undefined) return FortiMessages.incomplete('a TFTP server address');
    try { return new IPAddress(server); }
    catch {
      return FortiMessages.valueError(
        server, 'a TFTP server address is an IPv4 address.');
    }
  }

  private tftpClient(address: IPAddress): TftpClientSession {
    return new TftpClientSession(
      this.fw.getUdpEndpoint(), address, undefined,
      TFTP_EXPORT_TIMEOUT_MS, TFTP_EXPORT_MAX_RETRIES);
  }

  private executeBackup(rest: readonly string[]): string {
    if (rest[0] !== 'config' && rest[0] !== 'full-config') {
      return rest[0] === undefined
        ? FortiMessages.incomplete('what to back up')
        : FortiMessages.unknownAction(`backup ${rest[0]}`);
    }
    const [destination, file, server, password] = rest.slice(1);
    const address = this.tftpTarget(destination, server);
    if (typeof address === 'string') return address;
    if (file === undefined) return FortiMessages.incomplete('a file name');

    const clear = renderWholeConfig(this.tree, { full: rest[0] === 'full-config' }).join('\n');
    const text = password === undefined ? clear : encryptConfig(clear, password);
    this.pendingAsync = this.tftpClient(address).put(file, text).then(result => (
      result.ok ? '' : FortiMessages.commandFail(
        `the TFTP server at ${server} did not take "${file}" `
        + `(${result.error ?? 'Timed out'}).`)));
    return '';
  }

  private executeRestore(rest: readonly string[]): string {
    if (rest[0] !== 'config') {
      return rest[0] === undefined
        ? FortiMessages.incomplete('what to restore')
        : FortiMessages.unknownAction(`restore ${rest[0]}`);
    }
    if (rest[1] === 'flash') return this.restoreRevision(rest[2]);
    const [destination, file, server, password] = rest.slice(1);
    const address = this.tftpTarget(destination, server);
    if (typeof address === 'string') return address;
    if (file === undefined) return FortiMessages.incomplete('a file name');

    this.pendingAsync = this.tftpClient(address).get(file).then(result => {
      if (!result.ok || result.content === undefined) {
        return FortiMessages.commandFail(
          `the TFTP server at ${server} did not give "${file}" `
          + `(${result.error ?? 'Timed out'}).`);
      }
      const clear = this.restorableText(result.content, file, password);
      if (typeof clear !== 'string') return clear.refusal;
      this.factoryReset();
      this.absorbClusterConfiguration(clear);
      return '';
    });
    return '';
  }

  private restoreRevision(raw: string | undefined): string {
    if (raw === undefined) return FortiMessages.incomplete('a revision id');
    const id = Number.parseInt(raw, 10);
    const revision = Number.isFinite(id)
      ? this.fw.getRevisions().get(id) : undefined;
    if (!revision) {
      return FortiMessages.commandFail(`revision ${raw} does not exist.`);
    }
    this.factoryReset();
    this.absorbClusterConfiguration(revision.text);
    return '';
  }

  private executeRevision(rest: readonly string[]): string {
    const [action, target, raw] = rest;
    if (action !== 'list' && action !== 'delete') {
      return action === undefined
        ? FortiMessages.incomplete('list or delete')
        : FortiMessages.unknownAction(`revision ${action}`);
    }
    if (target !== 'config') {
      return target === undefined
        ? FortiMessages.incomplete('config')
        : FortiMessages.unknownAction(`revision ${action} ${target}`);
    }

    if (action === 'list') {
      return renderRevisionList(this.fw.getRevisions().list(), this.fw.localNow());
    }

    if (raw === undefined) return FortiMessages.incomplete('a revision id');
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || !this.fw.getRevisions().remove(id)) {
      return FortiMessages.commandFail(`revision ${raw} does not exist.`);
    }
    return '';
  }

  private restorableText(
    content: string, file: string, password: string | undefined,
  ): string | { refusal: string } {
    if (!isEncryptedConfig(content)) {
      return password === undefined ? content : { refusal: FortiMessages.commandFail(
        `"${file}" is not encrypted; restoring it takes no password.`) };
    }
    if (password === undefined) {
      return { refusal: FortiMessages.commandFail(
        `"${file}" is encrypted; restoring it takes the backup password.`) };
    }
    const clear = decryptConfig(content, password);
    return clear === null
      ? { refusal: FortiMessages.commandFail(
        `"${file}" did not decrypt; the backup password is wrong or the file is damaged.`) }
      : clear;
  }

  factoryReset(): void {
    this.nav.abort();
    this.tree.clear();
    this.vdom = 'root';
    this.globalScope = false;
    for (const path of this.tree.specPaths()) {
      const spec = this.tree.spec(path);
      if (spec) this.nav.commitDefaults(spec);
    }
    this.tree.clear();
    this.fw.applyFactoryIdentity();
    this.seedFactoryCertificates();
    this.seedFactoryAdmin();
    this.seedFactoryVdoms();
  }

  private executeCertificate(rest: readonly string[]): string {
    if (rest[0] !== 'local' || rest[1] !== 'export') {
      return FortiMessages.commandFail(
        'only `execute vpn certificate local export` is available here.');
    }
    const [destination, name, file, server] = rest.slice(2);
    if (!destination || !name || !file) {
      return FortiMessages.incomplete('a destination, a certificate name and a file name');
    }
    const entry = this.fw.getCertificateStore().local(name);
    if (!entry) return FortiMessages.commandFail(`certificate "${name}" does not exist.`);

    if (destination !== 'tftp') {
      return FortiMessages.commandFail(
        `destination "${destination}" is not available; this unit has no USB port `
        + 'and no FTP client.');
    }
    if (!server) return FortiMessages.incomplete('a TFTP server address');

    let address: IPAddress;
    try { address = new IPAddress(server); }
    catch { return FortiMessages.valueError(server, 'a TFTP server address is an IPv4 address.'); }

    const client = new TftpClientSession(
      this.fw.getUdpEndpoint(), address, undefined,
      TFTP_EXPORT_TIMEOUT_MS, TFTP_EXPORT_MAX_RETRIES);
    this.pendingAsync = client.put(file, entry.certificatePem).then(result => (
      result.ok ? '' : FortiMessages.commandFail(
        `the TFTP server at ${server} did not take "${file}" `
        + `(${result.error ?? 'Timed out'}).`)));
    return '';
  }

  snifferPlanFor(commandLine: string): SnifferPlan | null {
    const words = commandLine.trim().split(/\s+/);
    if (words[0] !== 'diagnose' || words[1] !== 'sniffer') return null;
    return parseSnifferPlan(
      words.slice(2), (name) => this.fw.getPort(name) !== undefined);
  }

  private appliquerAlimentation(action: 'reboot' | 'shutdown' | 'factoryreset'): string {
    if (action === 'reboot') this.fw.rebootNow();
    else if (action === 'shutdown') this.fw.shutdownNow();
    else { this.factoryReset(); this.fw.rebootNow(); }
    return annonceAlimentation(action);
  }

  interactionPlanFor(commandLine: string): CommandInteractionPlan | null {
    const words = commandLine.trim().split(/\s+/);
    if (words.length !== 2 || words[0] !== 'execute') return null;

    const resolved = resolvePrefix(words[1], executeNames());
    const action = resolved.name;
    if (action !== 'reboot' && action !== 'shutdown' && action !== 'factoryreset') {
      return null;
    }

    const announcement = annonceAlimentation(action);
    return {
      steps: [
        { kind: 'output', lines: [announcement] },
        {
          kind: 'confirmation',
          prompt: 'Do you want to continue? (y/n)',
          storeAs: 'forti_power_confirm',
        },
        {
          kind: 'run',
          run: async (runtime) => {
            if ((runtime.values.get('forti_power_confirm') ?? '') !== 'yes') return;
            if (action === 'reboot') this.fw.rebootNow();
            else if (action === 'shutdown') this.fw.shutdownNow();
            else { this.factoryReset(); this.fw.rebootNow(); }
          },
        },
      ],
    };
  }

  private executeVerb(rest: readonly string[]): string {
    if (rest.length === 0) return FortiMessages.incomplete('a command');

    const resolved = resolvePrefix(rest[0], executeNames());
    if (resolved.name === undefined) {
      return resolved.candidates.length > 1
        ? FortiMessages.ambiguous(rest[0], resolved.candidates)
        : FortiMessages.unknownAction(rest[0]);
    }

    const tail = rest.slice(1);
    switch (resolved.name) {
      case 'log': return runExecuteLog(tail, this.diagDeps());
      case 'ha': return this.executeHa(tail);
      case 'dhcp': return this.executeDhcp(tail);
      case 'traceroute':
        return tail.length === 0
          ? FortiMessages.incomplete('a destination')
          : this.fw.runTraceroute(tail[0]);
      case 'vpn':
        if (tail.length === 0) return FortiMessages.incomplete('a VPN operation');
        return tail[0] === 'certificate'
          ? this.executeCertificate(tail.slice(1))
          : FortiMessages.unknownAction(`vpn ${tail[0]}`);
      case 'time': return runExecuteTime(tail, this.fw);
      case 'date': return runExecuteDate(tail, this.fw);
      case 'ping':
        return tail.length === 0
          ? FortiMessages.incomplete('a destination')
          : this.fw.runPing(tail[0]);
      case 'ping6':
        return tail.length === 0
          ? FortiMessages.incomplete('a destination')
          : this.fw.getPing6().run(tail[0]);
      case 'ping-options':
        return this.executePingOptions(this.fw.getPingOptions(), 'ping-options', tail);
      case 'ping6-options':
        return this.executePingOptions(this.fw.getPing6Options(), 'ping6-options', tail);
      case 'clear': return this.executeClear(tail);
      case 'update-now': return this.executeFortiguardUpdate();
      case 'update-av': return this.executeFortiguardUpdate('antivirus');
      case 'update-ips': return this.executeFortiguardUpdate('ips');
      case 'disconnect-admin-session':
        return tail.length === 0
          ? FortiMessages.incomplete('a session index')
          : this.disconnectAdminSession(tail[0]);
      case 'enter':
        return tail.length === 0
          ? FortiMessages.incomplete('a VDOM name')
          : this.enterVdom(tail[0]);
      case 'backup': return this.executeBackup(tail);
      case 'restore': return this.executeRestore(tail);
      case 'revision': return this.executeRevision(tail);
      case 'factoryreset': case 'reboot': case 'shutdown':
        return this.appliquerAlimentation(resolved.name);
      case 'ssh': case 'telnet':
        return tail.length === 0
          ? FortiMessages.incomplete('a destination')
          : FortiMessages.needsConsole(resolved.name);
      default: return FortiMessages.unknownAction(resolved.name);
    }
  }

  private executeFortiguardUpdate(family?: FortiGuardFamily): string {
    this.fw.getFortiGuard().recordAttempt(family);
    return FORTIGUARD_UNREACHABLE;
  }

  private disconnectAdminSession(raw: string): string {
    const index = Number.parseInt(raw, 10);
    if (!Number.isInteger(index) || String(index) !== raw.trim()) {
      return FortiMessages.commandFail(`"${raw}" is not a session index.`);
    }
    const closed = this.fw.getAdminSessions().close(index);
    return closed === undefined
      ? FortiMessages.commandFail(`no administrator session with index ${index}.`)
      : '';
  }

  private enterVdom(name: string): string {
    if (!this.fw.getVdomRegistry().has(name)) {
      return FortiMessages.commandFail(`virtual domain "${name}" does not exist.`);
    }
    this.globalScope = false;
    this.enteredVdom = name;
    this.vdom = name;
    this.fw.setActiveVdom(name);
    return '';
  }

  private executeClear(rest: readonly string[]): string {
    if (rest.length === 0) return FortiMessages.incomplete('what to clear');
    if (rest[0] === 'system' && rest[1] === 'arp' && rest[2] === 'table') {
      this.fw.getArpService().clear();
      return '';
    }
    return FortiMessages.unknownAction(`clear ${rest.join(' ')}`);
  }

  private executeDhcp(rest: readonly string[]): string {
    if (rest.length === 0) return FortiMessages.incomplete('a DHCP operation');
    if (rest[0] === 'lease-list') return renderDhcpLeases(this.fw.getDhcp().leases());
    if (rest[0] === 'lease-clear') {
      if (rest.length < 2) return FortiMessages.incomplete('an IP address');
      return this.fw.getDhcp().clearLease(rest[1])
        ? '' : FortiMessages.commandFail(`no lease held for ${rest[1]}.`);
    }
    return FortiMessages.unknownAction(`dhcp ${rest[0]}`);
  }

  private executePingOptions(
    store: PingOptions, commande: string, rest: readonly string[],
  ): string {
    if (rest.length === 0) return FortiMessages.incomplete('a ping option');
    if (rest[0] === 'view-settings') return store.viewSettings();

    const refused = UNSIMULATED_PING_OPTIONS[rest[0]];
    if (refused && store.knows(rest[0])) {
      return FortiMessages.unimplemented(`${commande} ${rest[0]}`, refused);
    }

    const outcome = store.set(rest[0], rest[1]);
    return outcome.ok ? '' : FortiMessages.commandFail(outcome.message);
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
      const peer = peers[index - 1];
      const label = peer.hostname.length > 0 ? peer.hostname : peer.serial;
      this.haPendingLogin = {
        serial: peer.serial, hostname: label, admin: rest[2] ?? 'admin',
      };
      return `Connecting to ${label} (${peer.serial})...\n${label} password: `;
    }
    if (rest[0] === 'synchronize') {
      if (rest[1] === 'start') {
        return ha.requestSynchronisation()
          ? '' : FortiMessages.commandFail('no response from the cluster.');
      }
      if (rest[1] === 'stop') { return ''; }
      return FortiMessages.incomplete('`start` or `stop`');
    }
    return FortiMessages.unknownPath(`ha ${rest.join(' ')}`);
  }

  private finishHaLogin(secret: string): string {
    const attempt = this.haPendingLogin;
    this.haPendingLogin = null;
    if (attempt === null) return '';

    const answer = this.fw.getHa()
      .askPeer(attempt.serial, 'authenticate', attempt.admin, secret, '', '');
    if (!answer.answered) {
      return FortiMessages.commandFail('no response from the cluster member.');
    }
    if (!answer.accepted) return 'Login incorrect';

    this.haRemote = {
      serial: attempt.serial, hostname: attempt.hostname,
      admin: attempt.admin, token: answer.token,
    };
    return '';
  }

  private relayToHaPeer(line: string): string {
    const remote = this.haRemote;
    if (remote === null) return '';
    if (line.trim() === 'exit') { this.haRemote = null; return ''; }

    const answer = this.fw.getHa()
      .askPeer(remote.serial, 'cli', remote.admin, '', remote.token, line);
    if (!answer.answered) {
      this.haRemote = null;
      return FortiMessages.commandFail('the cluster member stopped responding.');
    }
    return answer.output;
  }

  private logConfigurationChange(change: FortiConfigChange): void {
    this.fw.getLogStore().append(configChangeLog({
      now: this.fw.now(),
      action: change.action,
      path: change.path,
      key: change.key,
      attributes: change.attributes,
      user: this.adminName ?? 'admin',
      ui: this.administrativeInterface(),
      transactionId: ++this.configTransactionId,
    }));
  }

  private origin = DEFAULT_ADMINISTRATIVE_INTERFACE;

  setAdministrativeInterface(origin: string): void {
    this.origin = origin.length > 0 ? origin : DEFAULT_ADMINISTRATIVE_INTERFACE;
  }

  private administrativeInterface(): string {
    return this.haRemote !== null ? DEFAULT_ADMINISTRATIVE_INTERFACE : this.origin;
  }

  private configTransactionId = 0;

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

const TRAILING_BACKSLASH = /(^|[^\\])\\\s*$/;

function endsWithContinuation(line: string): boolean {
  return TRAILING_BACKSLASH.test(line) && !hasOpenQuote(line);
}

function stillOpen(buffer: string): boolean {
  return hasOpenQuote(buffer) || endsWithContinuation(buffer);
}

function joinContinuation(buffer: string, next: string): string {
  if (!endsWithContinuation(buffer)) return `${buffer}\n${next}`;
  return `${buffer.replace(/\s*\\\s*$/, '')} ${next.replace(/^\s+/, '')}`;
}

function hasOpenQuote(text: string): boolean {
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
  }
  return quoted;
}


