/**
 * CiscoAclCommands - ACL (Access Control List) command registration for Cisco IOS CLI
 *
 * Registers commands on CommandTrie instances for:
 *   - Global config mode: access-list, ip access-list, no access-list, no ip access-list
 *   - Interface config mode: ip access-group, no ip access-group
 *   - Named standard ACL config mode: permit/deny entries
 *   - Named extended ACL config mode: permit/deny entries
 *   - Show commands: show access-lists, show ip access-lists
 */

import { IPAddress, SubnetMask } from '../../../core/types';
import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext, CiscoShellMode } from './CiscoConfigCommands';

// ─── Extended Shell Context for ACL modes ────────────────────────────

export interface CiscoACLShellContext extends CiscoShellContext {
  /** Get currently editing named ACL name */
  getSelectedACL(): string | null;
  /** Set currently editing named ACL name */
  setSelectedACL(name: string | null): void;
  /** Get the type of named ACL being edited */
  getSelectedACLType(): 'standard' | 'extended' | null;
  /** Set the type of named ACL being edited */
  setSelectedACLType(type: 'standard' | 'extended' | null): void;
}

// ─── ACL Parsing Helpers ──────────────────────────────────────────────

function parseAddressWildcard(args: string[], offset: number): { ip: IPAddress; wildcard: SubnetMask; consumed: number } | null {
  if (offset >= args.length) return null;

  const token = args[offset].toLowerCase();
  if (token === 'any') {
    return { ip: new IPAddress('0.0.0.0'), wildcard: new SubnetMask('255.255.255.255'), consumed: 1 };
  }
  if (token === 'host') {
    if (offset + 1 >= args.length) return null;
    return { ip: new IPAddress(args[offset + 1]), wildcard: new SubnetMask('0.0.0.0'), consumed: 2 };
  }
  // IP + wildcard
  if (offset + 1 >= args.length) return null;
  return { ip: new IPAddress(args[offset]), wildcard: new SubnetMask(args[offset + 1]), consumed: 2 };
}

function parsePort(args: string[], offset: number): { port: number; consumed: number } | null {
  if (offset >= args.length) return null;
  if (args[offset].toLowerCase() !== 'eq') return null;
  if (offset + 1 >= args.length) return null;
  const port = resolvePortName(args[offset + 1]);
  if (port === null) return null;
  return { port, consumed: 2 };
}

const PORT_NAME_MAP: Record<string, number> = {
  ftp: 21, ftp_data: 20, 'ftp-data': 20, ssh: 22, telnet: 23, smtp: 25,
  domain: 53, www: 80, http: 80, pop3: 110, ntp: 123, snmp: 161,
  snmptrap: 162, bgp: 179, https: 443, syslog: 514, tacacs: 49,
  rip: 520, isakmp: 500, 'non500-isakmp': 4500, sip: 5060,
  imap: 143, ldap: 389, 'ldap-s': 636, dhcp: 67, bootps: 67, bootpc: 68,
  tftp: 69, kerberos: 88, nntp: 119, finger: 79, gopher: 70,
};

function resolvePortName(token: string): number | null {
  const n = parseInt(token, 10);
  if (!isNaN(n)) return n;
  const v = PORT_NAME_MAP[token.toLowerCase()];
  return v ?? null;
}

function parsePortSpec(args: string[], offset: number): { spec: import('../../router/ACLEngine').PortSpec; consumed: number } | null {
  if (offset >= args.length) return null;
  const op = args[offset].toLowerCase();
  if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'lt') {
    if (offset + 1 >= args.length) return null;
    const port = resolvePortName(args[offset + 1]);
    if (port === null) return null;
    return { spec: { op: op as 'eq' | 'neq' | 'gt' | 'lt', port }, consumed: 2 };
  }
  if (op === 'range') {
    if (offset + 2 >= args.length) return null;
    const a = resolvePortName(args[offset + 1]);
    const b = resolvePortName(args[offset + 2]);
    if (a === null || b === null) return null;
    return { spec: { op: 'range', port: a, endPort: b }, consumed: 3 };
  }
  return null;
}

const ICMP_TYPE_KEYWORDS = new Set([
  'echo', 'echo-reply', 'unreachable', 'time-exceeded', 'redirect',
  'router-advertisement', 'router-solicitation', 'source-quench',
  'mask-request', 'mask-reply', 'information-request', 'information-reply',
  'timestamp-reply', 'timestamp-request', 'traceroute', 'administratively-prohibited',
  'host-unreachable', 'net-unreachable', 'port-unreachable', 'protocol-unreachable',
  'packet-too-big', 'parameter-problem', 'ttl-exceeded',
]);

interface ExtendedOptions {
  srcPortSpec?: import('../../router/ACLEngine').PortSpec;
  dstPortSpec?: import('../../router/ACLEngine').PortSpec;
  icmpType?: string;
  icmpCode?: number;
  tcpEstablished?: boolean;
  tcpFlags?: string[];
  dscp?: string;
  precedence?: string;
  tos?: string;
  log?: boolean;
  logInput?: boolean;
  timeRange?: string;
  reflect?: string;
  reflectTimeout?: number;
  fragments?: boolean;
  optionName?: string;
}

function parseTrailingOptions(args: string[], startOffset: number, protocol: string): ExtendedOptions {
  const opts: ExtendedOptions = {};
  let i = startOffset;
  while (i < args.length) {
    const tok = args[i].toLowerCase();
    if (protocol === 'icmp' && ICMP_TYPE_KEYWORDS.has(tok)) {
      opts.icmpType = tok;
      i++;
      const next = args[i];
      if (next !== undefined && /^\d+$/.test(next)) {
        opts.icmpCode = parseInt(next, 10);
        i++;
      }
      continue;
    }
    if (protocol === 'tcp' && tok === 'established') {
      opts.tcpEstablished = true;
      i++;
      continue;
    }
    if (protocol === 'tcp' && (tok === 'match-any' || tok === 'match-all')) {
      const flags: string[] = [];
      i++;
      while (i < args.length && !isTerminatorKeyword(args[i].toLowerCase())) {
        flags.push(args[i]);
        i++;
      }
      opts.tcpFlags = flags;
      continue;
    }
    if (tok === 'log') {
      opts.log = true;
      i++;
      continue;
    }
    if (tok === 'log-input') {
      opts.logInput = true;
      i++;
      continue;
    }
    if (tok === 'dscp' && i + 1 < args.length) {
      opts.dscp = args[i + 1];
      i += 2;
      continue;
    }
    if (tok === 'precedence' && i + 1 < args.length) {
      opts.precedence = args[i + 1];
      i += 2;
      continue;
    }
    if (tok === 'tos' && i + 1 < args.length) {
      opts.tos = args[i + 1];
      i += 2;
      continue;
    }
    if (tok === 'time-range' && i + 1 < args.length) {
      opts.timeRange = args[i + 1];
      i += 2;
      continue;
    }
    if (tok === 'reflect' && i + 1 < args.length) {
      opts.reflect = args[i + 1];
      i += 2;
      if (i + 1 < args.length && args[i].toLowerCase() === 'timeout') {
        const t = parseInt(args[i + 1], 10);
        if (!isNaN(t)) {
          opts.reflectTimeout = t;
          i += 2;
        }
      }
      continue;
    }
    if (tok === 'fragments') {
      opts.fragments = true;
      i++;
      continue;
    }
    if (tok === 'option' && i + 1 < args.length) {
      opts.optionName = args[i + 1];
      i += 2;
      continue;
    }
    i++;
  }
  return opts;
}

function isTerminatorKeyword(tok: string): boolean {
  return tok === 'log' || tok === 'log-input' || tok === 'dscp' || tok === 'precedence'
    || tok === 'tos' || tok === 'time-range' || tok === 'reflect' || tok === 'fragments'
    || tok === 'option' || tok === 'established';
}

// ─── Standard ACL Source Parsing ──────────────────────────────────────

function parseStandardSource(args: string[]): { ip: IPAddress; wildcard: SubnetMask; consumed: number } | null {
  if (args.length === 0) return null;
  const lower0 = args[0].toLowerCase();
  if (lower0 === 'any') {
    return { ip: new IPAddress('0.0.0.0'), wildcard: new SubnetMask('255.255.255.255'), consumed: 1 };
  }
  if (lower0 === 'host') {
    if (args.length < 2) return null;
    return { ip: new IPAddress(args[1]), wildcard: new SubnetMask('0.0.0.0'), consumed: 2 };
  }
  if (args.length < 2 || !/^\d/.test(args[1])) {
    return { ip: new IPAddress(args[0]), wildcard: new SubnetMask('0.0.0.0'), consumed: 1 };
  }
  return { ip: new IPAddress(args[0]), wildcard: new SubnetMask(args[1]), consumed: 2 };
}

function consumedAfterSource(_args: string[]): number {
  return 0;
}

// ─── Global Config Mode: access-list commands ─────────────────────────

export function buildACLConfigCommands(trie: CommandTrie, ctx: CiscoACLShellContext): void {
  // access-list <number> {permit|deny} ...
  trie.registerGreedy('access-list', 'Define a standard or extended access list', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const num = parseInt(args[0], 10);
    if (isNaN(num)) return '% Invalid access-list number.';

    // Validate range: 1-99 standard, 100-199 extended
    if (num < 1 || num > 199) return '% Invalid access-list number. Valid range: 1-199.';

    const action = args[1].toLowerCase();
    if (action !== 'permit' && action !== 'deny') return `% Invalid action "${args[1]}"`;

    if (num <= 99) {
      const rest = args.slice(2);
      const src = parseStandardSource(rest);
      if (!src) return '% Incomplete command.';
      const tailOffset = src.consumed ?? consumedAfterSource(rest);
      const tail = parseTrailingOptions(rest, tailOffset, 'ip');
      ctx.r().addAccessListEntry(num, action as 'permit' | 'deny', {
        srcIP: src.ip,
        srcWildcard: src.wildcard,
        log: tail.log,
        logInput: tail.logInput,
        timeRange: tail.timeRange,
      });
      return '';
    } else {
      if (args.length < 3) return '% Incomplete command.';
      const protocol = args[2].toLowerCase();
      let offset = 3;

      const src = parseAddressWildcard(args, offset);
      if (!src) return '% Incomplete command.';
      offset += src.consumed;

      const srcPortSpec = parsePortSpec(args, offset);
      if (srcPortSpec) offset += srcPortSpec.consumed;

      const dst = parseAddressWildcard(args, offset);
      if (!dst) return '% Incomplete command.';
      offset += dst.consumed;

      const dstPortSpec = parsePortSpec(args, offset);
      if (dstPortSpec) offset += dstPortSpec.consumed;

      const tail = parseTrailingOptions(args, offset, protocol);

      ctx.r().addAccessListEntry(num, action as 'permit' | 'deny', {
        protocol,
        srcIP: src.ip,
        srcWildcard: src.wildcard,
        dstIP: dst.ip,
        dstWildcard: dst.wildcard,
        srcPort: srcPortSpec?.spec.op === 'eq' ? srcPortSpec.spec.port : undefined,
        dstPort: dstPortSpec?.spec.op === 'eq' ? dstPortSpec.spec.port : undefined,
        srcPortSpec: srcPortSpec?.spec,
        dstPortSpec: dstPortSpec?.spec,
        ...tail,
      });
      return '';
    }
  });

  // no access-list <number>
  trie.registerGreedy('no access-list', 'Remove an access list', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const num = parseInt(args[0], 10);
    if (isNaN(num)) return '% Invalid access-list number.';
    ctx.r().removeAccessList(num);
    return '';
  });

  // ip access-list standard <name>
  trie.registerGreedy('ip access-list standard', 'Create a named standard access list', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    ctx.setSelectedACL(name);
    ctx.setSelectedACLType('standard');
    ctx.setMode('config-std-nacl' as CiscoShellMode);
    return '';
  });

  // ip access-list extended <name>
  trie.registerGreedy('ip access-list extended', 'Create a named extended access list', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    ctx.setSelectedACL(name);
    ctx.setSelectedACLType('extended');
    ctx.setMode('config-ext-nacl' as CiscoShellMode);
    return '';
  });

  // no ip access-list standard <name>
  trie.registerGreedy('no ip access-list standard', 'Remove a named standard access list', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r().removeNamedAccessList(args[0]);
    return '';
  });

  // no ip access-list extended <name>
  trie.registerGreedy('no ip access-list extended', 'Remove a named extended access list', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r().removeNamedAccessList(args[0]);
    return '';
  });

  trie.registerGreedy('ip access-list resequence', 'Resequence an access list', (args) => {
    if (args.length < 3) return '% Incomplete command.';
    const name = args[0];
    const start = parseInt(args[1], 10);
    const step = parseInt(args[2], 10);
    if (isNaN(start) || isNaN(step)) return '% Invalid arguments';
    const ok = ctx.r()._resequenceNamedACL(name, start, step);
    return ok ? '' : `% Access-list ${name} not found`;
  });
}

// ─── Interface Config Mode: ip access-group ───────────────────────────

export function buildACLInterfaceCommands(trie: CommandTrie, ctx: CiscoACLShellContext): void {
  trie.registerGreedy('ip access-group', 'Set access group on interface', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';

    const aclRef = args[0];
    const direction = args[1].toLowerCase();
    if (direction !== 'in' && direction !== 'out') return `% Invalid direction "${args[1]}"`;

    // Try to parse as number, otherwise use as name
    const num = parseInt(aclRef, 10);
    ctx.r().setInterfaceACL(ifName, direction as 'in' | 'out', isNaN(num) ? aclRef : num);
    return '';
  });

  trie.registerGreedy('no ip access-group', 'Remove access group from interface', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';

    const direction = args[1].toLowerCase();
    if (direction !== 'in' && direction !== 'out') return `% Invalid direction "${args[1]}"`;

    ctx.r().removeInterfaceACL(ifName, direction as 'in' | 'out');
    return '';
  });
}

// ─── Named Standard ACL Config Mode ──────────────────────────────────

export function buildNamedStdACLCommands(trie: CommandTrie, ctx: CiscoACLShellContext): void {
  const handle = (action: 'permit' | 'deny', args: string[], sequence?: number): string => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    const src = parseStandardSource(args);
    if (!src) return '% Incomplete command.';
    const tail = parseTrailingOptions(args, src.consumed, 'ip');
    ctx.r().addNamedAccessListEntry(aclName, 'standard', action, {
      sequence,
      srcIP: src.ip,
      srcWildcard: src.wildcard,
      log: tail.log,
      logInput: tail.logInput,
      timeRange: tail.timeRange,
    });
    return '';
  };
  trie.registerGreedy('permit', 'Specify packets to permit', (args) => handle('permit', args));
  trie.registerGreedy('deny', 'Specify packets to reject', (args) => handle('deny', args));
  registerSequenceEdits(trie, ctx, 'standard', handle);
  trie.registerGreedy('remark', 'ACL remark', (args) => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    ctx.r().addNamedAccessListEntry(aclName, 'standard', 'permit', {
      srcIP: new IPAddress('0.0.0.0'),
      srcWildcard: new SubnetMask('255.255.255.255'),
      remark: args.join(' '),
    });
    return '';
  });
}

function registerSequenceEdits(
  trie: CommandTrie,
  ctx: CiscoACLShellContext,
  _aclType: 'standard' | 'extended',
  handle: (action: 'permit' | 'deny', args: string[], sequence?: number) => string,
): void {
  trie.registerGreedy('no', 'Remove an entry', (args) => {
    if (args.length === 0) return '% Incomplete command.';
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    const seq = parseInt(args[0], 10);
    if (!isNaN(seq) && args.length === 1) {
      const ok = ctx.r()._removeNamedACLEntryBySequence(aclName, seq);
      return ok ? '' : '% Sequence number not found';
    }
    return '% Incomplete command.';
  });
  for (let n = 1; n <= 99; n++) {
    void n;
  }
  trie.registerGreedy('sequence', 'Sequence number', (args) => {
    if (args.length < 3) return '% Incomplete command.';
    const seq = parseInt(args[0], 10);
    if (isNaN(seq)) return '% Invalid sequence number.';
    const action = args[1].toLowerCase();
    if (action !== 'permit' && action !== 'deny') return '% Invalid action.';
    return handle(action as 'permit' | 'deny', args.slice(2), seq);
  });
}

// ─── Named Extended ACL Config Mode ──────────────────────────────────

export function buildNamedExtACLCommands(trie: CommandTrie, ctx: CiscoACLShellContext): void {
  const addEntry = (action: 'permit' | 'deny', args: string[], sequence?: number): string => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    if (args.length < 1) return '% Incomplete command.';

    const protocol = args[0].toLowerCase();
    let offset = 1;

    const src = parseAddressWildcard(args, offset);
    if (!src) return '% Incomplete command.';
    offset += src.consumed;

    const srcPortSpec = parsePortSpec(args, offset);
    if (srcPortSpec) offset += srcPortSpec.consumed;

    const dst = parseAddressWildcard(args, offset);
    if (!dst) return '% Incomplete command.';
    offset += dst.consumed;

    const dstPortSpec = parsePortSpec(args, offset);
    if (dstPortSpec) offset += dstPortSpec.consumed;

    const tail = parseTrailingOptions(args, offset, protocol);

    ctx.r().addNamedAccessListEntry(aclName, 'extended', action, {
      sequence,
      protocol,
      srcIP: src.ip,
      srcWildcard: src.wildcard,
      dstIP: dst.ip,
      dstWildcard: dst.wildcard,
      srcPort: srcPortSpec?.spec.op === 'eq' ? srcPortSpec.spec.port : undefined,
      dstPort: dstPortSpec?.spec.op === 'eq' ? dstPortSpec.spec.port : undefined,
      srcPortSpec: srcPortSpec?.spec,
      dstPortSpec: dstPortSpec?.spec,
      ...tail,
    });
    return '';
  };

  trie.registerGreedy('permit', 'Specify packets to permit', (args) => addEntry('permit', args));
  trie.registerGreedy('deny', 'Specify packets to reject', (args) => addEntry('deny', args));
  trie.registerGreedy('evaluate', 'Evaluate reflexive ACL', (args) => {
    const aclName = ctx.getSelectedACL();
    if (!aclName || args.length < 1) return '% Incomplete command.';
    ctx.r().addNamedAccessListEntry(aclName, 'extended', 'permit', {
      protocol: 'ip',
      srcIP: new IPAddress('0.0.0.0'),
      srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'),
      dstWildcard: new SubnetMask('255.255.255.255'),
      evaluate: args[0],
    });
    return '';
  });
  trie.registerGreedy('remark', 'ACL remark', (args) => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    ctx.r().addNamedAccessListEntry(aclName, 'extended', 'permit', {
      protocol: 'ip',
      srcIP: new IPAddress('0.0.0.0'),
      srcWildcard: new SubnetMask('255.255.255.255'),
      dstIP: new IPAddress('0.0.0.0'),
      dstWildcard: new SubnetMask('255.255.255.255'),
      remark: args.join(' '),
    });
    return '';
  });
  registerSequenceEdits(trie, ctx, 'extended', addEntry);
}

// ─── Show Commands ────────────────────────────────────────────────────

export function showAccessLists(router: Router, ref?: string): string {
  const all = router._getAccessListsInternal();
  let acls = all;
  if (ref) {
    const num = parseInt(ref, 10);
    if (!isNaN(num)) acls = all.filter(a => a.id === num);
    else acls = all.filter(a => a.name === ref);
    if (acls.length === 0) return `% Access list ${ref} not found`;
  }
  if (acls.length === 0) return '';
  const lines: string[] = [];
  for (const acl of acls) {
    const label = acl.name || String(acl.id);
    const typeStr = acl.type === 'standard' ? 'Standard' : 'Extended';
    lines.push(`${typeStr} IP access list ${label}`);
    for (const entry of acl.entries) {
      const seq = entry.sequence !== undefined ? `${entry.sequence} ` : '';
      lines.push(`    ${seq}${formatACLEntry(acl.type, entry)} (${entry.matchCount} match${entry.matchCount !== 1 ? 'es' : ''})`);
    }
  }
  return lines.join('\n');
}

function formatPortSpec(spec: import('../../router/ACLEngine').PortSpec | undefined, exact: number | undefined): string {
  if (spec) {
    if (spec.op === 'range') return ` range ${spec.port} ${spec.endPort}`;
    return ` ${spec.op} ${spec.port}`;
  }
  if (exact !== undefined) return ` eq ${exact}`;
  return '';
}

function formatACLEntry(aclType: 'standard' | 'extended', entry: import('../../Router').ACLEntry): string {
  if (entry.remark) return `remark ${entry.remark}`;
  if (entry.evaluate) return `evaluate ${entry.evaluate}`;
  const action = entry.action;
  if (aclType === 'standard') {
    const tail = formatTrailing(entry);
    return `${action} ${formatSrcAddr(entry.srcIP, entry.srcWildcard)}${tail}`;
  }
  const proto = entry.protocol || 'ip';
  const src = formatSrcAddr(entry.srcIP, entry.srcWildcard);
  const dst = entry.dstIP && entry.dstWildcard
    ? formatSrcAddr(entry.dstIP, entry.dstWildcard)
    : 'any';
  let result = `${action} ${proto} ${src}`;
  result += formatPortSpec(entry.srcPortSpec, entry.srcPort);
  result += ` ${dst}`;
  result += formatPortSpec(entry.dstPortSpec, entry.dstPort);
  if (entry.icmpType) {
    result += ` ${entry.icmpType}`;
    if (entry.icmpCode !== undefined) result += ` ${entry.icmpCode}`;
  }
  if (entry.tcpEstablished) result += ' established';
  if (entry.tcpFlags && entry.tcpFlags.length) result += ' match-any ' + entry.tcpFlags.join(' ');
  result += formatTrailing(entry);
  return result;
}

function formatTrailing(entry: import('../../Router').ACLEntry): string {
  let s = '';
  if (entry.precedence) s += ` precedence ${entry.precedence}`;
  if (entry.tos) s += ` tos ${entry.tos}`;
  if (entry.dscp) s += ` dscp ${entry.dscp}`;
  if (entry.fragments) s += ' fragments';
  if (entry.optionName) s += ` option ${entry.optionName}`;
  if (entry.timeRange) s += ` time-range ${entry.timeRange}`;
  if (entry.reflect) {
    s += ` reflect ${entry.reflect}`;
    if (entry.reflectTimeout !== undefined) s += ` timeout ${entry.reflectTimeout}`;
  }
  if (entry.logInput) s += ' log-input';
  else if (entry.log) s += ' log';
  return s;
}

function formatSrcAddr(ip: IPAddress, wildcard: SubnetMask): string {
  const wStr = wildcard.toString();
  if (wStr === '255.255.255.255') return 'any';
  if (wStr === '0.0.0.0') return `host ${ip}`;
  return `${ip} ${wStr}`;
}

// ─── Show ACL entries in running-config ───────────────────────────────

export function runningConfigACL(router: Router): string[] {
  const acls = router._getAccessListsInternal();
  const bindings = router._getInterfaceACLBindingsInternal();
  const lines: string[] = [];

  // Numbered ACLs
  for (const acl of acls) {
    if (acl.id !== undefined) {
      for (const entry of acl.entries) {
        lines.push(`access-list ${acl.id} ${formatACLEntry(acl.type, entry).replace(/ \(\d+ match(es)?\)/, '')}`);
      }
    }
  }

  // Named ACLs
  for (const acl of acls) {
    if (acl.name) {
      lines.push(`ip access-list ${acl.type} ${acl.name}`);
      for (const entry of acl.entries) {
        lines.push(` ${formatACLEntry(acl.type, entry).replace(/ \(\d+ match(es)?\)/, '')}`);
      }
    }
  }

  return lines;
}

export function runningConfigInterfaceACL(router: Router, ifName: string): string[] {
  const bindings = router._getInterfaceACLBindingsInternal();
  const binding = bindings.get(ifName);
  const lines: string[] = [];
  if (binding?.inbound !== null && binding?.inbound !== undefined) {
    lines.push(` ip access-group ${binding.inbound} in`);
  }
  if (binding?.outbound !== null && binding?.outbound !== undefined) {
    lines.push(` ip access-group ${binding.outbound} out`);
  }
  return lines;
}

// ─── Register show commands ───────────────────────────────────────────

export function registerACLShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.registerGreedy('show access-lists', 'Display all access lists', (args) => showAccessLists(getRouter(), args[0]));
  trie.registerGreedy('show ip access-lists', 'Display IP access lists', (args) => showAccessLists(getRouter(), args[0]));
  trie.registerGreedy('show ipv6 access-list', 'Display IPv6 access lists', (args) => showIPv6AccessLists(getRouter(), args[0]));
  trie.registerGreedy('show ipv6 access-lists', 'Display IPv6 access lists', (args) => showIPv6AccessLists(getRouter(), args[0]));
}

export function showIPv6AccessLists(router: Router, name?: string): string {
  const r = router as any;
  const acls: any[] = r.ipv6AccessLists ?? [];
  const filtered = name ? acls.filter((a: any) => a.name === name) : acls;
  if (filtered.length === 0) return '';
  const lines: string[] = [];
  for (const acl of filtered) {
    lines.push(`IPv6 access list ${acl.name}`);
    for (const e of acl.entries) {
      if (e.remark) { lines.push(`    remark ${e.remark}`); continue; }
      if (e.evaluate) { lines.push(`    evaluate ${e.evaluate}`); continue; }
      const proto = e.protocol ?? 'ipv6';
      const src = e.srcPrefix === 'any' || !e.srcPrefix ? 'any' : (e.srcPrefixLength !== undefined ? `${e.srcPrefix}/${e.srcPrefixLength}` : e.srcPrefix);
      const dst = e.dstPrefix === 'any' || !e.dstPrefix ? 'any' : (e.dstPrefixLength !== undefined ? `${e.dstPrefix}/${e.dstPrefixLength}` : e.dstPrefix);
      let line = `    ${e.action} ${proto} ${src} ${dst}`;
      if (e.dstPort) line += ` eq ${e.dstPort}`;
      if (e.log) line += ' log';
      lines.push(line);
    }
  }
  return lines.join('\n');
}

// ─── IPv6 Named ACL Commands ──────────────────────────────────────────

function addIPv6ACLEntry(router: Router, name: string, action: 'permit' | 'deny', prefixStr: string | null): void {
  const r = router as any;
  if (!r.ipv6AccessLists) r.ipv6AccessLists = [];
  let acl = r.ipv6AccessLists.find((a: any) => a.name === name);
  if (!acl) {
    acl = { name, entries: [] };
    r.ipv6AccessLists.push(acl);
  }
  if (prefixStr) {
    const slash = prefixStr.indexOf('/');
    const prefix = slash !== -1 ? prefixStr.substring(0, slash) : prefixStr;
    const prefixLength = slash !== -1 ? parseInt(prefixStr.substring(slash + 1), 10) : 128;
    acl.entries.push({ action, prefix, prefixLength });
  } else {
    acl.entries.push({ action });
  }
}

/**
 * Register 'ipv6 access-list <name>' in the global config trie.
 * Entering this command creates/selects the ACL and enters config-ipv6-nacl mode.
 */
export function buildIPv6ACLGlobalCommands(configTrie: CommandTrie, ctx: CiscoACLShellContext): void {
  configTrie.registerGreedy('ipv6 access-list', 'Define IPv6 named access list', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    // Ensure the ACL exists
    addIPv6ACLEntry(ctx.r(), name, 'permit', null);
    const r = ctx.r() as any;
    const acl = r.ipv6AccessLists.find((a: any) => a.name === name);
    if (acl) acl.entries = []; // reset if re-entering
    ctx.setSelectedACL(name);
    ctx.setMode('config-ipv6-nacl');
    return '';
  });
}

/**
 * Register permit/deny commands for the config-ipv6-nacl mode trie.
 */
export function buildIPv6ACLModeCommands(trie: CommandTrie, ctx: CiscoACLShellContext): void {
  const handle = (action: 'permit' | 'deny', args: string[]): string => {
    const name = ctx.getSelectedACL();
    if (!name) return '% No ACL selected';
    if (args.length < 1) return '% Incomplete command.';
    const r = ctx.r() as any;
    if (!r.ipv6AccessLists) r.ipv6AccessLists = [];
    let acl = r.ipv6AccessLists.find((a: any) => a.name === name);
    if (!acl) { acl = { name, entries: [] }; r.ipv6AccessLists.push(acl); }
    const protocol = args[0].toLowerCase();
    const isProtoFamily = protocol === 'ipv6' || protocol === 'tcp' || protocol === 'udp' || protocol === 'icmp';
    const entry: any = { action, protocol };
    let i = isProtoFamily ? 1 : 0;
    if (args[i]?.toLowerCase() === 'any') { entry.srcPrefix = 'any'; i++; }
    else if (args[i]?.toLowerCase() === 'host' && args[i + 1]) { entry.srcPrefix = args[i + 1]; i += 2; }
    else if (args[i]) {
      const slash = args[i].indexOf('/');
      entry.srcPrefix = slash !== -1 ? args[i].substring(0, slash) : args[i];
      entry.srcPrefixLength = slash !== -1 ? parseInt(args[i].substring(slash + 1), 10) : 128;
      i++;
    }
    if (args[i]?.toLowerCase() === 'any') { entry.dstPrefix = 'any'; i++; }
    else if (args[i]?.toLowerCase() === 'host' && args[i + 1]) { entry.dstPrefix = args[i + 1]; i += 2; }
    else if (args[i]) {
      const slash = args[i].indexOf('/');
      entry.dstPrefix = slash !== -1 ? args[i].substring(0, slash) : args[i];
      entry.dstPrefixLength = slash !== -1 ? parseInt(args[i].substring(slash + 1), 10) : 128;
      i++;
    }
    while (i < args.length) {
      const tok = args[i].toLowerCase();
      if (tok === 'eq' && args[i + 1]) { entry.dstPort = args[i + 1]; i += 2; continue; }
      if (tok === 'log') { entry.log = true; i++; continue; }
      if (tok === 'sequence' && args[i + 1]) { entry.sequence = parseInt(args[i + 1], 10); i += 2; continue; }
      i++;
    }
    acl.entries.push(entry);
    return '';
  };
  trie.registerGreedy('permit', 'Permit matching IPv6 packets', (args) => handle('permit', args));
  trie.registerGreedy('deny', 'Deny matching IPv6 packets', (args) => handle('deny', args));
  trie.registerGreedy('evaluate', 'Evaluate reflexive ACL', (args) => {
    const name = ctx.getSelectedACL();
    if (!name || !args[0]) return '';
    const r = ctx.r() as any;
    if (!r.ipv6AccessLists) r.ipv6AccessLists = [];
    const acl = r.ipv6AccessLists.find((a: any) => a.name === name);
    if (acl) acl.entries.push({ action: 'permit', protocol: 'ipv6', evaluate: args[0] });
    return '';
  });
  trie.registerGreedy('remark', 'ACL remark', (args) => {
    const name = ctx.getSelectedACL();
    if (!name) return '';
    const r = ctx.r() as any;
    if (!r.ipv6AccessLists) r.ipv6AccessLists = [];
    const acl = r.ipv6AccessLists.find((a: any) => a.name === name);
    if (acl) acl.entries.push({ action: 'permit', protocol: 'ipv6', remark: args.join(' ') });
    return '';
  });
}
