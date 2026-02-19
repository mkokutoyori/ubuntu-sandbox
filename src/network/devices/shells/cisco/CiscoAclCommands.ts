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
  const port = parseInt(args[offset + 1], 10);
  if (isNaN(port)) return null;
  return { port, consumed: 2 };
}

// ─── Standard ACL Source Parsing ──────────────────────────────────────

function parseStandardSource(args: string[]): { ip: IPAddress; wildcard: SubnetMask } | null {
  if (args.length === 0) return null;
  const lower0 = args[0].toLowerCase();
  if (lower0 === 'any') {
    return { ip: new IPAddress('0.0.0.0'), wildcard: new SubnetMask('255.255.255.255') };
  }
  if (lower0 === 'host') {
    if (args.length < 2) return null;
    return { ip: new IPAddress(args[1]), wildcard: new SubnetMask('0.0.0.0') };
  }
  if (args.length < 2) {
    // Single IP with implicit host mask (0.0.0.0)
    return { ip: new IPAddress(args[0]), wildcard: new SubnetMask('0.0.0.0') };
  }
  return { ip: new IPAddress(args[0]), wildcard: new SubnetMask(args[1]) };
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
      // Standard ACL: access-list <num> {permit|deny} <source> [wildcard]
      const rest = args.slice(2);
      const src = parseStandardSource(rest);
      if (!src) return '% Incomplete command.';

      ctx.r().addAccessListEntry(num, action as 'permit' | 'deny', {
        srcIP: src.ip,
        srcWildcard: src.wildcard,
      });
      return '';
    } else {
      // Extended ACL: access-list <num> {permit|deny} <protocol> <src> [eq port] <dst> [eq port]
      if (args.length < 3) return '% Incomplete command.';
      const protocol = args[2].toLowerCase();
      let offset = 3;

      const src = parseAddressWildcard(args, offset);
      if (!src) return '% Incomplete command.';
      offset += src.consumed;

      // Optional source port
      const srcPort = parsePort(args, offset);
      if (srcPort) offset += srcPort.consumed;

      const dst = parseAddressWildcard(args, offset);
      if (!dst) return '% Incomplete command.';
      offset += dst.consumed;

      // Optional destination port
      const dstPort = parsePort(args, offset);

      ctx.r().addAccessListEntry(num, action as 'permit' | 'deny', {
        protocol,
        srcIP: src.ip,
        srcWildcard: src.wildcard,
        dstIP: dst.ip,
        dstWildcard: dst.wildcard,
        srcPort: srcPort?.port,
        dstPort: dstPort?.port,
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
  // permit <source> [wildcard]
  trie.registerGreedy('permit', 'Specify packets to permit', (args) => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    const src = parseStandardSource(args);
    if (!src) return '% Incomplete command.';

    ctx.r().addNamedAccessListEntry(aclName, 'standard', 'permit', {
      srcIP: src.ip,
      srcWildcard: src.wildcard,
    });
    return '';
  });

  trie.registerGreedy('deny', 'Specify packets to reject', (args) => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    const src = parseStandardSource(args);
    if (!src) return '% Incomplete command.';

    ctx.r().addNamedAccessListEntry(aclName, 'standard', 'deny', {
      srcIP: src.ip,
      srcWildcard: src.wildcard,
    });
    return '';
  });
}

// ─── Named Extended ACL Config Mode ──────────────────────────────────

export function buildNamedExtACLCommands(trie: CommandTrie, ctx: CiscoACLShellContext): void {
  const addEntry = (action: 'permit' | 'deny', args: string[]): string => {
    const aclName = ctx.getSelectedACL();
    if (!aclName) return '% No ACL selected';
    if (args.length < 1) return '% Incomplete command.';

    const protocol = args[0].toLowerCase();
    let offset = 1;

    const src = parseAddressWildcard(args, offset);
    if (!src) return '% Incomplete command.';
    offset += src.consumed;

    const srcPort = parsePort(args, offset);
    if (srcPort) offset += srcPort.consumed;

    const dst = parseAddressWildcard(args, offset);
    if (!dst) return '% Incomplete command.';
    offset += dst.consumed;

    const dstPort = parsePort(args, offset);

    ctx.r().addNamedAccessListEntry(aclName, 'extended', action, {
      protocol,
      srcIP: src.ip,
      srcWildcard: src.wildcard,
      dstIP: dst.ip,
      dstWildcard: dst.wildcard,
      srcPort: srcPort?.port,
      dstPort: dstPort?.port,
    });
    return '';
  };

  trie.registerGreedy('permit', 'Specify packets to permit', (args) => addEntry('permit', args));
  trie.registerGreedy('deny', 'Specify packets to reject', (args) => addEntry('deny', args));
}

// ─── Show Commands ────────────────────────────────────────────────────

export function showAccessLists(router: Router): string {
  const acls = router._getAccessListsInternal();
  if (acls.length === 0) return '';

  const lines: string[] = [];
  for (const acl of acls) {
    const label = acl.name || String(acl.id);
    const typeStr = acl.type === 'standard' ? 'Standard' : 'Extended';
    lines.push(`${typeStr} IP access list ${label}`);
    for (const entry of acl.entries) {
      lines.push(`    ${formatACLEntry(acl.type, entry)} (${entry.matchCount} match${entry.matchCount !== 1 ? 'es' : ''})`);
    }
  }
  return lines.join('\n');
}

function formatACLEntry(aclType: 'standard' | 'extended', entry: import('../../Router').ACLEntry): string {
  const action = entry.action;
  if (aclType === 'standard') {
    return `${action} ${formatSrcAddr(entry.srcIP, entry.srcWildcard)}`;
  }
  // Extended
  const proto = entry.protocol || 'ip';
  const src = formatSrcAddr(entry.srcIP, entry.srcWildcard);
  const dst = entry.dstIP && entry.dstWildcard
    ? formatSrcAddr(entry.dstIP, entry.dstWildcard)
    : 'any';
  let result = `${action} ${proto} ${src}`;
  if (entry.srcPort !== undefined) result += ` eq ${entry.srcPort}`;
  result += ` ${dst}`;
  if (entry.dstPort !== undefined) result += ` eq ${entry.dstPort}`;
  return result;
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
  trie.register('show access-lists', 'Display all access lists', () => showAccessLists(getRouter()));
  trie.register('show ip access-lists', 'Display IP access lists', () => showAccessLists(getRouter()));
}
