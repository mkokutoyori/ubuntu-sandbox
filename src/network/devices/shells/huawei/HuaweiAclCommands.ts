/**
 * HuaweiAclCommands - Huawei VRP ACL (Access Control List) commands
 *
 * Huawei ACL numbering:
 *   2000-2999: Basic ACL (matches on source IP only)
 *   3000-3999: Advanced ACL (matches on src/dst IP, protocol, ports)
 *
 * Commands:
 *   acl <number>                        — enter ACL configuration view
 *   rule permit/deny [source/dest/ip]   — add rule
 *   undo acl <number>                   — delete ACL
 *   display acl <number>                — show ACL rules
 *   traffic-filter inbound/outbound acl <number> — apply ACL to interface
 */

import { IPAddress, SubnetMask } from '../../../core/types';
import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';

export type HuaweiACLMode = 'acl-basic' | 'acl-advanced';

export interface HuaweiACLContext {
  r(): Router;
  setMode(mode: string): void;
  getSelectedACLNumber(): number | null;
  setSelectedACLNumber(n: number | null): void;
  getSelectedACLMode(): HuaweiACLMode | null;
  setSelectedACLMode(m: HuaweiACLMode | null): void;
  getSelectedACLName(): string | null;
  setSelectedACLName(n: string | null): void;
  getSelectedInterface(): string | null;
}

export function registerHuaweiACLSystemCommands(
  trie: CommandTrie,
  ctx: HuaweiACLContext,
): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('acl', 'Configure Access Control List', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';

    if (args[0].toLowerCase() === 'name') {
      if (args.length < 3) return 'Error: Incomplete command.';
      const name = args[1];
      const type = args[2].toLowerCase();
      if (type !== 'basic' && type !== 'advanced') return 'Error: Expected basic or advanced.';
      ctx.setSelectedACLName(name);
      ctx.setSelectedACLNumber(null);
      ctx.setSelectedACLMode(type === 'basic' ? 'acl-basic' : 'acl-advanced');
      ctx.setMode(type === 'basic' ? 'acl-basic' : 'acl-advanced');
      return '';
    }

    if (args[0].toLowerCase() === 'ipv6') {
      if (args.length < 3 || args[1].toLowerCase() !== 'name') return 'Error: Incomplete command.';
      const name = args[2];
      ctx.setSelectedACLName(name);
      ctx.setSelectedACLNumber(null);
      ctx.setSelectedACLMode('acl-advanced');
      ctx.setMode('acl-advanced');
      return '';
    }

    const num = parseInt(args[0], 10);
    if (isNaN(num)) return 'Error: Invalid ACL number.';
    if (num >= 2000 && num <= 2999) {
      ctx.setSelectedACLNumber(num);
      ctx.setSelectedACLName(null);
      ctx.setSelectedACLMode('acl-basic');
      ctx.setMode('acl-basic');
      return '';
    }
    if (num >= 3000 && num <= 3999) {
      ctx.setSelectedACLNumber(num);
      ctx.setSelectedACLName(null);
      ctx.setSelectedACLMode('acl-advanced');
      ctx.setMode('acl-advanced');
      return '';
    }
    return 'Error: ACL number must be 2000-2999 (basic) or 3000-3999 (advanced).';
  });

  trie.registerGreedy('undo acl', 'Delete Access Control List', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    if (args[0].toLowerCase() === 'name' && args.length >= 2) {
      getRouter().removeNamedAccessList(args[1]);
      return '';
    }
    const num = parseInt(args[0], 10);
    if (isNaN(num)) return 'Error: Invalid ACL number.';
    getRouter().removeAccessList(num);
    return '';
  });
}

export function buildHuaweiBasicACLCommands(
  trie: CommandTrie,
  ctx: HuaweiACLContext,
): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('rule', 'Add ACL rule', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const aclNum = ctx.getSelectedACLNumber();
    const aclName = ctx.getSelectedACLName();
    if (aclNum === null && aclName === null) return 'Error: No ACL selected.';

    const action = args[0].toLowerCase();
    if (action !== 'permit' && action !== 'deny') return 'Error: Expected permit or deny.';

    let srcIP = '0.0.0.0';
    let srcWild = '255.255.255.255';

    for (let i = 1; i < args.length; i++) {
      if (args[i].toLowerCase() === 'source') {
        if (args[i + 1]?.toLowerCase() === 'any') {
          srcIP = '0.0.0.0';
          srcWild = '255.255.255.255';
          i++;
        } else if (args[i + 1] && args[i + 2]) {
          srcIP = args[i + 1];
          srcWild = args[i + 2];
          i += 2;
        }
      }
    }

    const opts = {
      srcIP: new IPAddress(srcIP),
      srcWildcard: new SubnetMask(srcWild),
    };
    if (aclName) {
      getRouter().addNamedAccessListEntry(aclName, 'standard', action as 'permit' | 'deny', opts);
    } else {
      getRouter().addAccessListEntry(aclNum!, action as 'permit' | 'deny', opts);
    }
    return '';
  });
}

export function buildHuaweiAdvancedACLCommands(
  trie: CommandTrie,
  ctx: HuaweiACLContext,
): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('rule', 'Add ACL rule', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const aclNum = ctx.getSelectedACLNumber();
    const aclName = ctx.getSelectedACLName();
    if (aclNum === null && aclName === null) return 'Error: No ACL selected.';

    const action = args[0].toLowerCase();
    if (action !== 'permit' && action !== 'deny') return 'Error: Expected permit or deny.';

    let srcIP = '0.0.0.0';
    let srcWild = '255.255.255.255';
    let dstIP = '0.0.0.0';
    let dstWild = '255.255.255.255';
    let protocol: string | undefined;

    let i = 1;
    if (i < args.length && !['source', 'destination'].includes(args[i]?.toLowerCase())) {
      protocol = args[i].toLowerCase();
      i++;
    }

    while (i < args.length) {
      const kw = args[i].toLowerCase();
      if (kw === 'source') {
        if (args[i + 1]?.toLowerCase() === 'any') { i += 2; continue; }
        if (args[i + 1] && args[i + 2]) {
          srcIP = args[i + 1];
          srcWild = args[i + 2];
          i += 3;
        } else { i++; }
      } else if (kw === 'destination') {
        if (args[i + 1]?.toLowerCase() === 'any') { i += 2; continue; }
        if (args[i + 1] && args[i + 2]) {
          dstIP = args[i + 1];
          dstWild = args[i + 2];
          i += 3;
        } else { i++; }
      } else {
        i++;
      }
    }

    const opts = {
      protocol,
      srcIP: new IPAddress(srcIP),
      srcWildcard: new SubnetMask(srcWild),
      dstIP: new IPAddress(dstIP),
      dstWildcard: new SubnetMask(dstWild),
    };
    if (aclName) {
      getRouter().addNamedAccessListEntry(aclName, 'extended', action as 'permit' | 'deny', opts);
    } else {
      getRouter().addAccessListEntry(aclNum!, action as 'permit' | 'deny', opts);
    }
    return '';
  });
}

export function registerHuaweiACLInterfaceCommands(
  trie: CommandTrie,
  ctx: HuaweiACLContext,
): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('traffic-filter', 'Apply ACL to interface', (args) => {
    if (args.length < 3) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected';

    const direction = args[0].toLowerCase();
    if (direction !== 'inbound' && direction !== 'outbound') return 'Error: Expected inbound or outbound.';

    if (args[1].toLowerCase() !== 'acl') return 'Error: Expected "acl".';
    const aclNum = parseInt(args[2], 10);
    if (isNaN(aclNum)) return 'Error: Invalid ACL number.';

    const dir = direction === 'inbound' ? 'in' : 'out';
    getRouter().setInterfaceACL(ifName, dir as 'in' | 'out', aclNum);
    return '';
  });

  trie.registerGreedy('undo traffic-filter', 'Remove ACL from interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected';

    const direction = args[0].toLowerCase();
    const dir = direction === 'inbound' ? 'in' : 'out';
    getRouter().removeInterfaceACL(ifName, dir as 'in' | 'out');
    return '';
  });
}

function formatACLEntry(entry: any): string {
  let ruleStr = entry.action;
  const srcStr = entry.srcIP?.toString();
  const srcWild = entry.srcWildcard?.toString();
  if (srcStr && srcStr !== '0.0.0.0') {
    ruleStr += ` source ${srcStr} ${srcWild}`;
  }
  const dstStr = entry.dstIP?.toString();
  const dstWild = entry.dstWildcard?.toString();
  if (dstStr && dstStr !== '0.0.0.0') {
    ruleStr += ` destination ${dstStr} ${dstWild}`;
  }
  return ruleStr;
}

export function registerHuaweiACLDisplayCommands(
  trie: CommandTrie,
  getRouter: () => Router,
): void {
  trie.registerGreedy('display acl', 'Display ACL configuration', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';

    if (args[0].toLowerCase() === 'all') {
      return formatAllACLs(getRouter());
    }

    if (args[0].toLowerCase() === 'name' && args.length >= 2) {
      const name = args[1];
      const acls = getRouter()._getAccessListsInternal();
      const acl = acls.find(a => a.name === name);
      if (!acl || acl.entries.length === 0) {
        return `Error: ACL ${name} does not exist or has no rules.`;
      }
      const type = acl.type === 'extended' ? 'Advanced' : 'Basic';
      const lines = [`${type} ACL ${name}, ${acl.entries.length} rule(s)`, `ACL's step is 5`];
      acl.entries.forEach((entry, idx) => {
        lines.push(` rule ${idx * 5} ${formatACLEntry(entry)}`);
      });
      return lines.join('\n');
    }

    const num = parseInt(args[0], 10);
    if (isNaN(num)) return 'Error: Invalid ACL number.';

    const acls = getRouter()._getAccessListsInternal();
    const acl = acls.find(a => a.id === num);

    if (!acl || acl.entries.length === 0) {
      return `Error: ACL ${num} does not exist or has no rules.`;
    }

    const type = num >= 3000 ? 'Advanced' : 'Basic';
    const lines = [
      `${type} ACL ${num}, ${acl.entries.length} rule(s)`,
      `ACL's step is 5`,
    ];

    acl.entries.forEach((entry, idx) => {
      const ruleNum = idx * 5;
      lines.push(` rule ${ruleNum} ${formatACLEntry(entry)}`);
    });

    return lines.join('\n');
  });
}

function formatAllACLs(router: Router): string {
  const acls = router._getAccessListsInternal();
  if (acls.length === 0) return 'Total 0 ACL(s)';

  const lines: string[] = [];
  for (const acl of acls) {
    const label = acl.name ? `${acl.type === 'extended' ? 'Advanced' : 'Basic'} ACL ${acl.name}` :
      `${(acl.id ?? 0) >= 3000 ? 'Advanced' : 'Basic'} ACL ${acl.id}`;
    lines.push(`${label}, ${acl.entries.length} rule(s)`);
    lines.push(`ACL's step is 5`);
    acl.entries.forEach((entry, idx) => {
      const ruleNum = idx * 5;
      lines.push(` rule ${ruleNum} ${formatACLEntry(entry)}`);
    });
  }
  lines.push(`Total ${acls.length} ACL(s)`);
  return lines.join('\n');
}

export function runningConfigACL(router: Router): string[] {
  const acls = router._getAccessListsInternal();
  const lines: string[] = [];

  for (const acl of acls) {
    lines.push('#');
    if (acl.name) {
      lines.push(`acl name ${acl.name} ${acl.type === 'extended' ? 'advanced' : 'basic'}`);
    } else if (acl.id !== undefined) {
      lines.push(`acl number ${acl.id}`);
    } else {
      continue;
    }
    acl.entries.forEach((entry, idx) => {
      const ruleNum = idx * 5;
      lines.push(` rule ${ruleNum} ${formatACLEntry(entry)}`);
    });
  }

  return lines;
}

export function runningConfigInterfaceACL(router: Router, ifName: string): string[] {
  const lines: string[] = [];
  const inACL = router.getInterfaceACL(ifName, 'in');
  const outACL = router.getInterfaceACL(ifName, 'out');
  if (inACL !== null) lines.push(` traffic-filter inbound acl ${inACL}`);
  if (outACL !== null) lines.push(` traffic-filter outbound acl ${outACL}`);
  return lines;
}
