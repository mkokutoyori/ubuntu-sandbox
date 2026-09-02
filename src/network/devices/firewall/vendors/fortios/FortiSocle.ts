import { FORTI_EXECUTE_COMMANDS } from './execute/executeVocabulary';
import { LOG_CATEGORIES } from './log/logCategories';
import { argumentAccepts, type ArgumentSpec, type EnumValue } from '../../../../../cli/ArgumentTypes';
import { CommandTable, type CommandSpec } from '../../../../../cli/CommandTable';
import { newSession, type CliSession } from '../../../../../cli/CliSession';
import { parseCommand, uniqueChild } from '../../../../../cli/CommandParser';
import { complete, type CompletionTrigger, type Suggestion } from '../../../../../cli/CompletionEngine';
import { FortiMessages } from './FortiMessages';
import type { FortiAttributeSpec, FortiTableSpec } from './schema/types';
import type { AccessIntent, AccessVerdict } from '../../authz/AccessMatrix';
import type { FortiConfigTree } from './runtime/FortiConfigTree';
import type { FortiNavigator } from './runtime/FortiNavigator';
import { unquote } from './runtime/FortiNavigator';
import type { FortiObject } from './runtime/FortiObject';
import type { FortiTable } from './runtime/FortiTable';

const LEGENDS: ReadonlyArray<readonly [readonly string[], string]> = Object.freeze([
  [['config'], 'Configure object.'],
  [['config', 'firewall'], 'Configure firewall.'],
  [['config', 'firewall', 'service'], 'Configure services.'],
  [['config', 'firewall', 'schedule'], 'Configure schedules.'],
  [['config', 'system'], 'Configure system settings.'],
  [['config', 'system', 'dhcp'], 'Configure DHCP.'],
  [['config', 'router'], 'Configure router.'],
  [['config', 'log'], 'Configure logging.'],
  [['config', 'log', 'syslogd', 'setting'], 'Configure the first syslog collector.'],
  [['config', 'log', 'syslogd2', 'setting'], 'Configure the second syslog collector.'],
  [['config', 'log', 'memory'], 'Configure memory logging.'],
  [['diagnose'], 'Diagnose facility.'],
  [['diagnose', 'sys'], 'System diagnostics.'],
  [['diagnose', 'sys', 'session'], 'Session table diagnostics.'],
  [['diagnose', 'sys', 'sdwan'], 'SD-WAN diagnostics.'],
  [['diagnose', 'sys', 'ha'], 'Cluster diagnostics.'],
  [['diagnose', 'sys', 'ha', 'checksum'], 'Configuration checksums.'],
  [['execute', 'ha'], 'Cluster operations.'],
  [['execute', 'ha', 'failover'], 'Force a failover.'],
  [['diagnose', 'debug'], 'Debug facility.'],
  [['diagnose', 'debug', 'flow'], 'Trace the path a packet follows.'],
  [['diagnose', 'firewall'], 'Firewall diagnostics.'],
  [['diagnose', 'firewall', 'iprope'], 'Compiled policy table.'],
  [['diagnose', 'firewall', 'fqdn'], 'Resolved FQDN address objects.'],
  [['diagnose', 'firewall', 'vip'], 'Virtual IP table.'],
  [['diagnose', 'sniffer'], 'Packet sniffer.'],
  [['diagnose', 'ip'], 'IP layer diagnostics.'],
  [['diagnose', 'ip', 'address'], 'Interface addresses.'],
  [['diagnose', 'ip', 'arp'], 'ARP cache.'],
  [['diagnose', 'snmp'], 'SNMP counter diagnostics.'],
  [['diagnose', 'snmp', 'ip'], 'IP layer SNMP counters.'],
  [['diagnose', 'sys', 'ntp'], 'NTP client diagnostics.'],
  [['diagnose', 'sys', 'top'], 'Show the running processes.'],
  [['diagnose', 'sys', 'checkused'], 'Find what references an object.'],
  [['diagnose', 'sys', 'cmdb'], 'Configuration database diagnostics.'],
  [['diagnose', 'sys', 'cmdb', 'refcnt'], 'Datasource reference counters.'],
  [['diagnose', 'autoupdate'], 'FortiGuard update facility.'],
  [['diagnose', 'hardware'], 'Hardware information.'],
  [['diagnose', 'hardware', 'sysinfo'], 'System hardware information.'],
  [['diagnose', 'test'], 'Application test facility.'],
  [['diagnose', 'test', 'application'], 'Test a daemon.'],
  [['execute', 'ping'], 'Send ICMP echo requests.'],
  [['execute', 'ping6'], 'Send IPv6 ICMP echo requests.'],
  [['diagnose', 'ipv6'], 'IPv6 diagnostics.'],
  [['get', 'router', 'info6'], 'IPv6 routing information.'],
  [['execute', 'traceroute'], 'Trace the route to a destination.'],
  [['execute', 'dhcp'], 'DHCP server operations.'],
  [['execute', 'time'], 'Display or set the system time.'],
  [['execute', 'date'], 'Display or set the system date.'],
  [['execute'], 'Execute static commands.'],
  [['execute', 'log'], 'Log operations.'],
  [['execute', 'log', 'filter'], 'Set the log display filter.'],
  [['execute', 'log', 'filter', 'category'], 'Restrict the display to one log category.'],
  [['get'], 'Get dynamic and system information.'],
  [['set'], 'Set a field value.'],
  [['unset'], 'Reset a field to its default.'],
  [['append'], 'Append a value to a list.'],
  [['select'], 'Select a value from a list.'],
  [['unselect'], 'Remove a value from a list.'],
]);

export const VALUE_LIST_VERBS = Object.freeze(
  ['set', 'append', 'select', 'unselect'] as const);

export const FORTI_TOKENS = Object.freeze({ escapesAnyCharacter: true });

const FORTI_MODES = Object.freeze({ forti: { parent: null } });
const FORTI_PROMPTS = Object.freeze({ forti: '{host} # ' });
const MODE = ['forti'];

export interface SocleDeps {
  readonly tree: FortiConfigTree;
  readonly nav: FortiNavigator;
  readonly hostname: () => string;
  readonly device: unknown;
  readonly candidatesFor: (targets: readonly string[]) => readonly EnumValue[];
  readonly view: (rest: readonly string[], full: boolean) => string;
  readonly inspect: (rest: readonly string[]) => string;
  readonly diagnose: (rest: readonly string[]) => string;
  readonly runExecute: (rest: readonly string[]) => string;
  readonly leaveCli: () => string;
  readonly enterGlobal: () => string;
  readonly authorize?: (spec: FortiTableSpec, intent: AccessIntent) => AccessVerdict;
  readonly principal?: () => string;
  readonly vdomNames?: () => readonly string[];
  readonly enterVdom?: (name: string) => string;
}

export interface FortiOutcome {
  readonly handled: boolean;
  readonly output: string;
}

const UNHANDLED: FortiOutcome = Object.freeze({ handled: false, output: '' });

function done(output: string): FortiOutcome {
  return { handled: true, output };
}

export function existingEntryHelp(key: string): string {
  return `Existing entry ${key}.`;
}

export function branchHelp(spec: { help: string } | undefined, word: string): string {
  return spec ? spec.help : `Configure ${word}.`;
}

export class FortiSocle {
  private readonly cache = new Map<string, CommandTable>();

  constructor(private readonly deps: SocleDeps) {}

  execute(line: string): FortiOutcome {
    const table = this.contextTable();
    const session = this.session();
    const parsed = parseCommand(table, line, session, FORTI_TOKENS);

    switch (parsed.status) {
      case 'empty': return done('');
      case 'ambiguous':
        return done(FortiMessages.ambiguous(parsed.token, parsed.candidates));
      case 'incomplete':
        return done(FortiMessages.incomplete('the rest of the command'));
      case 'invalid': return UNHANDLED;
      case 'ok': {
        const output = parsed.spec.run(session, parsed.args);
        return done(typeof output === 'string' ? output : '');
      }
    }
  }

  suggestions(input: string, trigger: CompletionTrigger): readonly Suggestion[] {
    return complete(this.contextTable(), input, this.session(), trigger).suggestions;
  }

  completion(input: string): string | undefined {
    return complete(this.contextTable(), input, this.session(), 'TAB').completion;
  }

  canonicalWords(words: readonly string[]): readonly string[] {
    const table = this.contextTable();
    const session = this.session();
    let node = table.rootNode();
    const out: string[] = [];

    for (const word of words) {
      const child = uniqueChild(node, word, table, session);
      if (child?.keyword === undefined) return [...out, ...words.slice(out.length)];
      out.push(child.keyword);
      node = child;
    }
    return out;
  }

  private session(): CliSession {
    return newSession(this.deps.hostname(), this.deps.device, {
      hierarchy: FORTI_MODES, prompts: FORTI_PROMPTS,
      topLevel: 'forti', execLevel: 'forti', initialMode: 'forti',
    });
  }

  private contextTable(): CommandTable {
    const key = this.contextKey();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const table = new CommandTable();
    for (const spec of this.contextSpecs()) table.declare(spec);
    for (const [path, legend] of LEGENDS) table.describePath(path, legend);
    this.cache.set(key, table);
    return table;
  }

  private contextKey(): string {
    const principal = this.deps.principal ? this.deps.principal() : '';
    const object = this.deps.nav.currentObject();
    if (object) {
      const shape = object.availableAttributes().map(a => a.name).join(',');
      return `object:${principal}:${object.spec.path.join(' ')}:${shape}`
        + `:${this.referenceStamp(object)}`;
    }
    const table = this.deps.nav.currentTable();
    if (table) {
      return `table:${principal}:${table.spec.path.join(' ')}:${table.keys().join(',')}`;
    }
    return `root:${principal}:${this.deps.tree.specPaths().length}`
      + `:${(this.deps.vdomNames?.() ?? []).join(',')}`;
  }

  private referenceStamp(object: FortiObject): string {
    const parts: string[] = [];
    for (const attribute of object.availableAttributes()) {
      if (!attribute.referenceTo) continue;
      parts.push(this.deps.candidatesFor(attribute.referenceTo).map(v => v.keyword).join('|'));
    }
    return parts.join(';');
  }

  private contextSpecs(): CommandSpec[] {
    const object = this.deps.nav.currentObject();
    if (object) return this.objectSpecs(object);

    const table = this.deps.nav.currentTable();
    if (table) return this.tableSpecs(table);

    return this.rootSpecs();
  }

  private branchSpecs(): CommandSpec[] {
    const out: CommandSpec[] = [];
    for (const path of this.deps.tree.specPaths()) {
      const spec = this.deps.tree.spec(path);
      if (!spec || spec.scopeOnly) continue;

      const verdict = this.verdict(spec, 'write');
      if (verdict === 'absent') continue;

      const refused = () => FortiMessages.noPermission(path.join(' '));
      if (spec.keyOnConfigLine === true) {
        out.push(this.withArgument(
          `config ${path.join(' ')}`,
          ['config', ...path, {
            name: 'key', type: 'WORD', description: 'Message name.',
            alternatives: (spec.predefined ?? []).map(name => ({
              keyword: name, description: 'Replacement message.',
            })),
          }], spec.help,
          (_session, args) => verdict === 'read-only'
            ? refused()
            : this.deps.nav.descend([...path, unquote(args.key ?? '')]),
        ));
        continue;
      }
      out.push(this.plain(
        `config ${path.join(' ')}`, ['config', ...path], spec.help,
        () => verdict === 'read-only' ? refused() : this.deps.nav.descend(path),
      ));
    }
    return out;
  }

  private verdict(spec: FortiTableSpec, intent: AccessIntent): AccessVerdict {
    return this.deps.authorize ? this.deps.authorize(spec, intent) : 'run';
  }

  private rootSpecs(): CommandSpec[] {
    const out: CommandSpec[] = [
      this.plain('config global', ['config', 'global'],
        'Enter the global configuration scope.',
        () => this.deps.enterGlobal()),
      this.plain('config vdom', ['config', 'vdom'],
        'Configure virtual domain.',
        () => this.deps.nav.descend(['vdom'])),
      this.plain('exit', ['exit'], 'Exit the CLI.', () => this.deps.leaveCli()),
      this.plain('quit', ['quit'], 'Exit the CLI.', () => this.deps.leaveCli()),
    ];
    out.push(...this.branchSpecs());
    out.push(...this.viewSpecs());
    out.push(...this.diagnoseSpecs());
    out.push(...this.enterVdomSpecs());
    out.push(...this.executeSpecs(new Set(out.map(spec => spec.id))));
    out.push(this.withArgument('execute', ['execute',
      { name: 'command', type: 'REST', description: 'Command to execute.' }],
      'Execute static commands.',
      (_s, args) => this.deps.runExecute((args.command ?? '').split(/\s+/).filter(Boolean))));
    return out;
  }

  private enterVdomSpecs(): CommandSpec[] {
    const enter = this.deps.enterVdom;
    if (!enter) return [];
    return [this.withArgument('execute enter',
      ['execute', 'enter', {
        name: 'vdom', type: 'WORD', description: 'VDOM name.',
        alternatives: (this.deps.vdomNames?.() ?? []).map(name => ({
          keyword: name, description: 'Virtual domain.',
        })),
      }],
      'Select virtual domain.',
      (_session, args) => enter(args.vdom ?? ''))];
  }

  private executeSpecs(declared: ReadonlySet<string>): CommandSpec[] {
    return FORTI_EXECUTE_COMMANDS
      .filter(command => !declared.has(`execute ${command.name}`))
      .map(command => this.withArgument(
      `execute ${command.name}`,
      ['execute', command.name, {
        name: 'rest', type: 'REST', optional: true, description: command.help,
        ...(command.options ? { alternatives: [...command.options] } : {}),
      }],
      command.help,
      (_s, args) => this.deps.runExecute(
        [command.name, ...(args.rest ?? '').split(/\s+/).filter(Boolean)]),
      ));
  }

  private diagnoseSpecs(): CommandSpec[] {
    const rest = (name: string, description: string): ArgumentSpec => ({
      name, type: 'REST', optional: true, description,
    });
    const run = (words: readonly string[]) =>
      (_s: CliSession, args: Readonly<Record<string, string>>): string =>
        this.deps.diagnose([...words, ...(args.rest ?? '').split(/\s+/).filter(Boolean)]);
    const run2 = (words: readonly string[]) =>
      (_s: CliSession, args: Readonly<Record<string, string>>): string =>
        this.deps.runExecute([...words, ...(args.rest ?? '').split(/\s+/).filter(Boolean)]);

    return [
      this.withArgument('diagnose sys session list',
        ['diagnose', 'sys', 'session', 'list'], 'List the session table.',
        run(['sys', 'session', 'list'])),
      this.plain('diagnose ip address list',
        ['diagnose', 'ip', 'address', 'list'], 'List the interface addresses.',
        () => this.deps.diagnose(['ip', 'address', 'list'])),
      this.plain('diagnose ip arp list',
        ['diagnose', 'ip', 'arp', 'list'], 'List the ARP cache.',
        () => this.deps.diagnose(['ip', 'arp', 'list'])),
      this.withArgument('diagnose sys checkused',
        ['diagnose', 'sys', 'checkused', rest('rest', '<path.object.mkey> <value>')],
        'Find what references an object.', run(['sys', 'checkused'])),
      this.plain('diagnose ipv6 address list',
        ['diagnose', 'ipv6', 'address', 'list'], 'List the IPv6 interface addresses.',
        () => this.deps.diagnose(['ipv6', 'address', 'list'])),
      this.plain('diagnose ipv6 neighbor-cache list',
        ['diagnose', 'ipv6', 'neighbor-cache', 'list'], 'List the neighbour cache.',
        () => this.deps.diagnose(['ipv6', 'neighbor-cache', 'list'])),
      this.withArgument('diagnose sys cmdb refcnt show',
        ['diagnose', 'sys', 'cmdb', 'refcnt', 'show',
          rest('rest', '<path.object.attribute> <value>')],
        'Show what references a configuration object.',
        run(['sys', 'cmdb', 'refcnt', 'show'])),
      this.plain('diagnose lldprx neighbor summary',
        ['diagnose', 'lldprx', 'neighbor', 'summary'],
        'List the LLDP neighbours heard on every interface.',
        () => this.deps.diagnose(['lldprx', 'neighbor', 'summary'])),
      this.withArgument('diagnose lldprx port neighbor details',
        ['diagnose', 'lldprx', 'port', 'neighbor', 'details', rest('rest', '<interface>')],
        'Show every TLV of the LLDP neighbours heard on one interface.',
        (_session, args) =>
          this.deps.diagnose(['lldprx', 'port', 'neighbor', 'details', ...words(args.rest)])),
      this.plain('diagnose netlink aggregate list',
        ['diagnose', 'netlink', 'aggregate', 'list'],
        'List the aggregate interfaces of this virtual domain.',
        () => this.deps.diagnose(['netlink', 'aggregate', 'list'])),
      this.withArgument('diagnose netlink aggregate name',
        ['diagnose', 'netlink', 'aggregate', 'name', rest('rest', '<aggregate>')],
        'Show the LACP state of an aggregate interface.',
        (_session, args) =>
          this.deps.diagnose(['netlink', 'aggregate', 'name', ...words(args.rest)])),
      this.withArgument('diagnose netlink port',
        ['diagnose', 'netlink', 'port', rest('rest', '<aggregate> [filter]')],
        'Show which member port a flow would leave by.',
        (_session, args) =>
          this.deps.diagnose(['netlink', 'port', ...words(args.rest)])),
      this.plain('diagnose netlink brctl list',
        ['diagnose', 'netlink', 'brctl', 'list'],
        'List the bridge instances, one per virtual domain.',
        () => this.deps.diagnose(['netlink', 'brctl', 'list'])),
      this.withArgument('diagnose netlink brctl name host',
        ['diagnose', 'netlink', 'brctl', 'name', 'host', rest('rest', '<bridge>')],
        'Show the forwarding database of a bridge instance.',
        (_session, args) =>
          this.deps.diagnose(['netlink', 'brctl', 'name', 'host', ...words(args.rest)])),
      this.plain('diagnose hardware sysinfo conserve',
        ['diagnose', 'hardware', 'sysinfo', 'conserve'],
        'Show the memory conserve mode state and its thresholds.',
        () => this.deps.diagnose(['hardware', 'sysinfo', 'conserve'])),
      this.plain('diagnose hardware sysinfo memory',
        ['diagnose', 'hardware', 'sysinfo', 'memory'],
        'Show the kernel memory counters.',
        () => this.deps.diagnose(['hardware', 'sysinfo', 'memory'])),
      this.plain('diagnose autoupdate versions',
        ['diagnose', 'autoupdate', 'versions'],
        'Show the FortiGuard database versions.',
        () => this.deps.diagnose(['autoupdate', 'versions'])),
      this.withArgument('diagnose test application',
        ['diagnose', 'test', 'application', rest('rest', '<daemon> <level>')],
        'Query a daemon.', run(['test', 'application'])),
      this.plain('diagnose firewall vip list',
        ['diagnose', 'firewall', 'vip', 'list'], 'List the virtual IPs.',
        () => this.deps.diagnose(['firewall', 'vip', 'list'])),
      this.plain('diagnose firewall fqdn list',
        ['diagnose', 'firewall', 'fqdn', 'list'], 'List the resolved FQDN objects.',
        () => this.deps.diagnose(['firewall', 'fqdn', 'list'])),
      this.withArgument('diagnose sys top',
        ['diagnose', 'sys', 'top', rest('rest', '<delay> <lines>')],
        'Show the running processes.', run(['sys', 'top'])),
      this.plain('diagnose sys ntp status',
        ['diagnose', 'sys', 'ntp', 'status'], 'Show the NTP synchronisation state.',
        () => this.deps.diagnose(['sys', 'ntp', 'status'])),
      this.plain('execute log display', ['execute', 'log', 'display'],
        'Display the filtered log records.',
        () => this.deps.runExecute(['log', 'display'])),
      this.plain('execute log delete-all', ['execute', 'log', 'delete-all'],
        'Delete every stored log record.',
        () => this.deps.runExecute(['log', 'delete-all'])),
      this.withArgument('execute log filter',
        ['execute', 'log', 'filter', rest('rest', 'Filter criterion.')],
        'Set the log display filter.', run2(['log', 'filter'])),
      this.withArgument('execute log filter category',
        ['execute', 'log', 'filter', 'category', {
          name: 'category', type: 'WORD', optional: true,
          description: 'Log category.',
          alternatives: LOG_CATEGORIES.map(entry => ({
            keyword: String(entry.index), description: entry.name,
          })),
        }],
        'Restrict the display to one log category.',
        (_s, args) => this.deps.runExecute(
          ['log', 'filter', 'category', ...(args.category ? [args.category] : [])])),
      this.withArgument('execute time',
        ['execute', 'time', rest('rest', 'New time, <hh:mm:ss>.')],
        'Display or set the system time.', run2(['time'])),
      this.withArgument('execute date',
        ['execute', 'date', rest('rest', 'New date, <yyyy-mm-dd>.')],
        'Display or set the system date.', run2(['date'])),
      this.plain('diagnose sys session stat',
        ['diagnose', 'sys', 'session', 'stat'], 'Session table statistics.',
        () => this.deps.diagnose(['sys', 'session', 'stat'])),
      this.plain('diagnose snmp ip frags',
        ['diagnose', 'snmp', 'ip', 'frags'], 'IP fragment reassembly counters.',
        () => this.deps.diagnose(['snmp', 'ip', 'frags'])),
      this.withArgument('diagnose sys session filter',
        ['diagnose', 'sys', 'session', 'filter', rest('rest', 'Filter criterion.')],
        'Set the session table filter.', run(['sys', 'session', 'filter'])),
      this.plain('diagnose sys session clear',
        ['diagnose', 'sys', 'session', 'clear'], 'Clear sessions matching the filter.',
        () => this.deps.diagnose(['sys', 'session', 'clear'])),
      this.withArgument('diagnose sys sdwan health-check',
        ['diagnose', 'sys', 'sdwan', 'health-check', rest('rest', 'Health check name.')],
        'Show what each SD-WAN health check measured.',
        run(['sys', 'sdwan', 'health-check'])),
      this.plain('diagnose sys sdwan member',
        ['diagnose', 'sys', 'sdwan', 'member'], 'List the SD-WAN members.',
        () => this.deps.diagnose(['sys', 'sdwan', 'member'])),
      this.plain('diagnose sys sdwan service',
        ['diagnose', 'sys', 'sdwan', 'service'], 'List the SD-WAN service rules.',
        () => this.deps.diagnose(['sys', 'sdwan', 'service'])),
      this.plain('diagnose sys ha status', ['diagnose', 'sys', 'ha', 'status'],
        'Show the cluster state.', () => this.deps.diagnose(['sys', 'ha', 'status'])),
      this.plain('diagnose sys ha checksum show',
        ['diagnose', 'sys', 'ha', 'checksum', 'show'],
        'Compare the members configuration checksums.',
        () => this.deps.diagnose(['sys', 'ha', 'checksum', 'show'])),
      this.plain('diagnose sys ha checksum cluster',
        ['diagnose', 'sys', 'ha', 'checksum', 'cluster'],
        'Compare the configuration checksums of every cluster member.',
        () => this.deps.diagnose(['sys', 'ha', 'checksum', 'cluster'])),
      this.plain('diagnose sys ha reset-uptime',
        ['diagnose', 'sys', 'ha', 'reset-uptime'],
        'Reset this member cluster uptime, so the peer wins the next election.',
        () => this.deps.diagnose(['sys', 'ha', 'reset-uptime'])),
      this.withArgument('execute ha synchronize',
        ['execute', 'ha', 'synchronize', rest('rest', '`start` or `stop`.')],
        'Start or stop a configuration synchronisation.',
        run2(['ha', 'synchronize'])),
      this.plain('execute ha failover set', ['execute', 'ha', 'failover', 'set'],
        'Give the primary role up.', () => this.deps.runExecute(['ha', 'failover', 'set'])),
      this.withArgument('execute ha manage',
        ['execute', 'ha', 'manage', rest('rest', 'Cluster member index.')],
        'Open the CLI of another cluster member.',
        run2(['ha', 'manage'])),
      this.plain('diagnose debug reset', ['diagnose', 'debug', 'reset'],
        'Reset the debug settings.', () => this.deps.diagnose(['debug', 'reset'])),
      this.plain('diagnose debug enable', ['diagnose', 'debug', 'enable'],
        'Enable debug output.', () => this.deps.diagnose(['debug', 'enable'])),
      this.plain('diagnose debug disable', ['diagnose', 'debug', 'disable'],
        'Disable debug output.', () => this.deps.diagnose(['debug', 'disable'])),
      this.withArgument('diagnose debug flow filter',
        ['diagnose', 'debug', 'flow', 'filter', rest('rest', 'Filter criterion.')],
        'Set the flow trace filter.', run(['debug', 'flow', 'filter'])),
      this.withArgument('diagnose debug flow trace',
        ['diagnose', 'debug', 'flow', 'trace', rest('rest', '`start <count>` or `stop`.')],
        'Start or stop the flow trace.', run(['debug', 'flow', 'trace'])),
      this.withArgument('diagnose debug flow show',
        ['diagnose', 'debug', 'flow', 'show', rest('rest', 'Display option.')],
        'Choose what the flow trace displays.', run(['debug', 'flow', 'show'])),
      this.withArgument('diagnose firewall iprope list',
        ['diagnose', 'firewall', 'iprope', 'list', rest('rest', 'Policy group.')],
        'List the compiled policies.', run(['firewall', 'iprope', 'list'])),
      this.withArgument('diagnose firewall iprope show',
        ['diagnose', 'firewall', 'iprope', 'show', rest('rest', '<group> <index>')],
        'Show one compiled policy.', run(['firewall', 'iprope', 'show'])),
      this.plain('diagnose vpn tunnel list',
        ['diagnose', 'vpn', 'tunnel', 'list'],
        'List the IPsec tunnels and their security associations.',
        () => this.deps.diagnose(['vpn', 'tunnel', 'list'])),
      this.withArgument('diagnose vpn tunnel up',
        ['diagnose', 'vpn', 'tunnel', 'up', rest('rest', 'Tunnel name.')],
        'Bring one IPsec tunnel up.', run(['vpn', 'tunnel', 'up'])),
      this.plain('diagnose vpn tunnel flush',
        ['diagnose', 'vpn', 'tunnel', 'flush'],
        'Flush every IPsec security association.',
        () => this.deps.diagnose(['vpn', 'tunnel', 'flush'])),
      this.plain('diagnose vpn ike gateway list',
        ['diagnose', 'vpn', 'ike', 'gateway', 'list'],
        'List the IKE gateways.',
        () => this.deps.diagnose(['vpn', 'ike', 'gateway', 'list'])),
      this.withArgument('diagnose vpn ike gateway list name',
        ['diagnose', 'vpn', 'ike', 'gateway', 'list', 'name', rest('rest', 'Gateway name.')],
        'List one IKE gateway.', run(['vpn', 'ike', 'gateway', 'list', 'name'])),
      this.withArgument('diagnose vpn ike gateway clear',
        ['diagnose', 'vpn', 'ike', 'gateway', 'clear', rest('rest', 'name <gateway>')],
        'Clear one IKE gateway and renegotiate it.',
        run(['vpn', 'ike', 'gateway', 'clear'])),
      this.plain('diagnose vpn ike gateway flush',
        ['diagnose', 'vpn', 'ike', 'gateway', 'flush'],
        'Clear every IKE gateway.',
        () => this.deps.diagnose(['vpn', 'ike', 'gateway', 'flush'])),
      this.plain('diagnose firewall auth list',
        ['diagnose', 'firewall', 'auth', 'list'],
        'List the authenticated users.',
        () => this.deps.diagnose(['firewall', 'auth', 'list'])),
      this.plain('diagnose firewall auth clear',
        ['diagnose', 'firewall', 'auth', 'clear'],
        'De-authenticate every user.',
        () => this.deps.diagnose(['firewall', 'auth', 'clear'])),
      this.withArgument('diagnose firewall auth filter',
        ['diagnose', 'firewall', 'auth', 'filter', rest('rest', 'Filter criterion.')],
        'Restrict what the authenticated-user list shows.',
        run(['firewall', 'auth', 'filter'])),
      this.withArgument('diagnose sniffer packet',
        ['diagnose', 'sniffer', 'packet', rest('rest', '<interface> <filter> [verbose] [count]')],
        'Capture packets on an interface.', run(['sniffer', 'packet'])),
    ];
  }

  private tableSpecs(table: FortiTable): CommandSpec[] {
    const spec = table.spec;
    const keys: readonly EnumValue[] = table.keys().map(k => ({
      keyword: k, description: existingEntryHelp(k),
    }));
    const keyArgument: ArgumentSpec = {
      name: 'key',
      type: spec.keyType === 'integer' ? 'INT' : 'WORD',
      description: spec.keyType === 'integer' ? 'Entry ID.' : 'Entry name.',
    };

    const out: CommandSpec[] = [
      this.withArgument('edit', ['edit', { ...keyArgument, alternatives: keys }],
        'Add/edit a table value.', (_s, args) => this.deps.nav.edit(args.key)),
      this.withArgument('delete', ['delete', { ...keyArgument, alternatives: keys }],
        'Delete a table value.', (_s, args) => this.deps.nav.delete(args.key)),
      this.plain('purge', ['purge'], 'Purge all the table entries.',
        () => this.deps.nav.purge()),
      this.withArgument('clone', ['clone',
        { ...keyArgument, name: 'from', alternatives: keys }, 'to',
        { ...keyArgument, name: 'to' }],
        'Clone an object instance.',
        (_s, args) => this.deps.nav.clone([args.from, 'to', args.to])),
      this.withArgument('rename', ['rename',
        { ...keyArgument, name: 'from', alternatives: keys }, 'to',
        { ...keyArgument, name: 'to' }],
        'Rename a table value.',
        (_s, args) => this.deps.nav.rename([args.from, 'to', args.to])),
      this.plain('end', ['end'], 'End and save.', () => this.deps.nav.end()),
      this.plain('abort', ['abort'], 'Exit without saving.', () => this.deps.nav.abort()),
    ];

    if (spec.ordered) {
      out.push(this.withArgument('move', ['move',
        { ...keyArgument, name: 'from', alternatives: keys },
        {
          name: 'position', type: 'ENUM', description: 'Placement.',
          values: [
            { keyword: 'before', description: 'Place before the target.' },
            { keyword: 'after', description: 'Place after the target.' },
          ],
        },
        { ...keyArgument, name: 'to', alternatives: keys }],
        'Move an object instance.',
        (_s, args) => this.deps.nav.move([args.from, args.position, args.to])));
    }

    out.push(...this.viewSpecs());
    return out;
  }

  private objectSpecs(object: FortiObject): CommandSpec[] {
    const out: CommandSpec[] = [
      this.plain('next', ['next'], 'Save and exit the object.', () => this.deps.nav.next()),
      this.plain('end', ['end'], 'End and save.', () => this.deps.nav.end()),
      this.plain('abort', ['abort'], 'Exit without saving.', () => this.deps.nav.abort()),
    ];

    const writable = this.verdict(object.spec, 'write') === 'run';
    for (const attribute of object.availableAttributes()) {
      if (attribute.readOnly) continue;
      if (!writable) continue;
      out.push(...this.attributeSpecs(attribute));
    }

    for (const name of object.childNames()) {
      const child = object.childSpec(name);
      if (!child) continue;
      out.push(this.plain(`config ${name}`, ['config', name], child.help,
        () => this.deps.nav.descend([name])));
    }

    if (object.spec.scopeOnly) out.push(...this.branchSpecs());

    out.push(...this.viewSpecs());
    return out;
  }

  private attributeSpecs(attribute: FortiAttributeSpec): CommandSpec[] {
    const value = this.valueArgument(attribute);
    const veil = (spec: CommandSpec): CommandSpec =>
      attribute.hidden === true ? { ...spec, hidden: true } : spec;
    const out: CommandSpec[] = [
      this.withArgument(`set ${attribute.name}`, ['set', attribute.name, ...value],
        attribute.help,
        (_s, args) => this.deps.nav.set(attribute.name, collect(value, args))),
      this.plain(`unset ${attribute.name}`, ['unset', attribute.name], attribute.help,
        () => this.deps.nav.unset(attribute.name)),
    ];

    if (!attribute.multiValue) return out.map(veil);

    for (const verb of VALUE_LIST_VERBS.slice(1)) {
      out.push(this.withArgument(`${verb} ${attribute.name}`,
        [verb, attribute.name, ...value], attribute.help,
        (_s, args) => this.deps.nav[verb](attribute.name, collect(value, args))));
    }
    return out.map(veil);
  }

  private valueArgument(attribute: FortiAttributeSpec): ArgumentSpec[] {
    if (attribute.unimplemented) {
      return [{ name: 'value', type: 'REST', description: attribute.help }];
    }
    if (attribute.multiValue) {
      const alternatives = attribute.referenceTo
        ? this.deps.candidatesFor(attribute.referenceTo)
        : undefined;
      return [{
        ...attribute.parts[0], name: 'value', type: 'REST',
        alternatives: alternatives && alternatives.length > 0 ? alternatives : undefined,
      }];
    }
    if (attribute.referenceTo) {
      const alternatives = this.deps.candidatesFor(attribute.referenceTo);
      return [{
        ...attribute.parts[0],
        alternatives: alternatives.length > 0 ? alternatives : undefined,
      }];
    }
    return [...attribute.parts];
  }

  private viewSpecs(): CommandSpec[] {
    const branches = this.branchAlternatives();
    return [
      this.withArgument('show', ['show',
        {
          name: 'path', type: 'REST', optional: true,
          description: 'Configuration path.', alternatives: branches,
        }],
        'Show configuration.',
        (_s, args) => this.deps.view(words(args.path), false)),
      this.withArgument('get', ['get',
        {
          name: 'path', type: 'REST', optional: true,
          description: 'Object path.', alternatives: branches,
        }],
        'Get dynamic and system information.',
        (_s, args) => this.deps.inspect(words(args.path))),
    ];
  }

  private branchAlternatives(): EnumValue[] {
    const seen = new Map<string, string>();
    for (const path of this.deps.tree.specPaths()) {
      const head = path[0];
      if (head === undefined || seen.has(head)) continue;
      const spec = this.deps.tree.spec(path);
      if (!spec || this.verdict(spec, 'read') === 'absent') continue;
      seen.set(head, branchHelp(path.length === 1 ? spec : undefined, head));
    }
    return [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([keyword, description]) => ({ keyword, description }));
  }

  private plain(
    id: string, path: readonly string[], description: string, run: () => string,
  ): CommandSpec {
    return { id, path, description, modes: MODE, minPrivilege: 0, run: () => run() };
  }

  private withArgument(
    id: string,
    path: readonly (string | ArgumentSpec)[],
    description: string,
    run: (session: CliSession, args: Readonly<Record<string, string>>) => string,
  ): CommandSpec {
    return { id, path, description, modes: MODE, minPrivilege: 0, run };
  }
}

function words(raw: string | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

function collect(
  parts: readonly ArgumentSpec[], args: Readonly<Record<string, string>>,
): string[] {
  if (parts.length === 1 && parts[0].type === 'REST') return words(args[parts[0].name]);
  return parts.map(part => args[part.name]).filter(v => v !== undefined);
}

export function valueAccepted(part: ArgumentSpec, token: string): boolean {
  return argumentAccepts(part, token);
}

export function tableHelp(spec: FortiTableSpec): string {
  return spec.help;
}
