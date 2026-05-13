/**
 * HuaweiNATCommands - NAT/PAT command registration for Huawei VRP CLI
 *
 * Supports (all under interface view unless stated otherwise):
 *   nat static global <globalIP> inside <localIP>
 *   nat outbound <acl-number>
 *   nat server protocol tcp|udp global <globalIP> <globalPort> inside <localIP> <localPort>
 *   undo nat static global <globalIP> inside <localIP>
 *   undo nat outbound <acl-number>
 *   undo nat server protocol tcp|udp global <globalIP> <globalPort>
 *
 *   display nat static           (user/system view)
 *   display nat outbound         (user/system view)
 *   display nat session          (user/system view)
 */

import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import type { HuaweiShellContext } from './HuaweiConfigCommands';

// ─── Interface View: nat static ──────────────────────────────────────────────

export function registerHuaweiNATInterfaceCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  // nat static global <globalIP> inside <localIP>
  trie.registerGreedy('nat static global', 'Configure static NAT', (args) => {
    // args: [globalIP, 'inside', localIP]
    if (args.length < 3) return 'Error: Incomplete command.';
    const globalIP = args[0];
    if (args[1]?.toLowerCase() !== 'inside') return 'Error: Expected "inside" keyword.';
    const localIP = args[2];
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    ctx.r()._getNATEngine().setOutsideInterface(ifName);
    ctx.r()._getNATEngine().addStaticEntry({ localIP, globalIP });
    return '';
  });

  // undo nat static global <globalIP> inside <localIP>
  trie.registerGreedy('undo nat static global', 'Remove static NAT', (args) => {
    if (args.length < 3) return 'Error: Incomplete command.';
    const globalIP = args[0];
    if (args[1]?.toLowerCase() !== 'inside') return 'Error: Expected "inside" keyword.';
    const localIP = args[2];
    ctx.r()._getNATEngine().removeStaticEntry(localIP, globalIP);
    return '';
  });

  // nat outbound <acl-number>  — PAT using outside interface IP
  trie.registerGreedy('nat outbound', 'Configure dynamic NAT/PAT outbound rule', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const aclId = args[0];
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    ctx.r()._getNATEngine().setOutsideInterface(ifName);
    // Check if a pool is specified: nat outbound <acl> address-group <pool>
    if (args[1]?.toLowerCase() === 'address-group' && args[2]) {
      ctx.r()._getNATEngine().addDynamicRule({ aclId, type: 'pool', poolName: args[2] });
    } else {
      ctx.r()._getNATEngine().addDynamicRule({ aclId, type: 'overload' });
    }
    return '';
  });

  // undo nat outbound <acl-number>
  trie.registerGreedy('undo nat outbound', 'Remove dynamic NAT outbound rule', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    ctx.r()._getNATEngine().removeDynamicRule(args[0]);
    return '';
  });

  // nat server protocol tcp|udp global <globalIP> <globalPort> inside <localIP> <localPort>
  trie.registerGreedy('nat server protocol', 'Configure NAT server (port forwarding)', (args) => {
    // args: [tcp|udp, global, globalIP, globalPort, inside, localIP, localPort]
    if (args.length < 7) return 'Error: Incomplete command.';
    const proto = args[0].toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp') return 'Error: Protocol must be tcp or udp.';
    if (args[1]?.toLowerCase() !== 'global') return 'Error: Expected "global" keyword.';
    const globalIP = args[2];
    const globalPort = parseInt(args[3], 10);
    if (args[4]?.toLowerCase() !== 'inside') return 'Error: Expected "inside" keyword.';
    const localIP = args[5];
    const localPort = parseInt(args[6], 10);
    if (isNaN(globalPort) || isNaN(localPort)) return 'Error: Invalid port number.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    ctx.r()._getNATEngine().setOutsideInterface(ifName);
    ctx.r()._getNATEngine().addStaticEntry({ localIP, globalIP, protocol: proto as 'tcp' | 'udp', localPort, globalPort });
    return '';
  });

  // undo nat server protocol tcp|udp global <globalIP> <globalPort>
  trie.registerGreedy('undo nat server protocol', 'Remove NAT server entry', (args) => {
    if (args.length < 4) return 'Error: Incomplete command.';
    const proto = args[0].toLowerCase();
    if (args[1]?.toLowerCase() !== 'global') return 'Error: Expected "global" keyword.';
    const globalIP = args[2];
    const globalPort = parseInt(args[3], 10);
    // Remove matching static entry
    const engine = ctx.r()._getNATEngine();
    const entries = engine.getStaticEntries();
    for (const e of entries) {
      if (e.globalIP === globalIP && e.globalPort === globalPort && e.protocol === proto) {
        engine.removeStaticEntry(e.localIP, e.globalIP);
        break;
      }
    }
    return '';
  });

  // nat aging-time tcp <seconds>  /  nat aging-time udp <seconds>  /  nat aging-time icmp <seconds>
  trie.registerGreedy('nat aging-time', 'Configure NAT session aging time', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    const proto = args[0].toLowerCase();
    const s = parseInt(args[1], 10);
    if (isNaN(s) || s < 1) return 'Error: Invalid timeout value.';
    const engine = ctx.r()._getNATEngine();
    if (proto === 'tcp')       engine.setTimeouts({ tcp: s * 1000 });
    else if (proto === 'udp')  engine.setTimeouts({ udp: s * 1000 });
    else if (proto === 'icmp') engine.setTimeouts({ icmp: s * 1000 });
    else if (proto === 'tcp-syn' || proto === 'syn') engine.setTimeouts({ tcpHalfOpen: s * 1000 });
    else return `Error: Unknown protocol "${args[0]}".`;
    return '';
  });

  // nat inside (mark interface as inside)
  trie.register('nat inside', 'Mark interface as NAT inside', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    ctx.r()._getNATEngine().setInsideInterface(ifName);
    return '';
  });

  trie.register('undo nat inside', 'Remove NAT inside designation', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    ctx.r()._getNATEngine().removeInsideInterface(ifName);
    return '';
  });
}

// ─── Display Commands ─────────────────────────────────────────────────────────

export function registerHuaweiNATDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('display nat static', 'Display static NAT translations', () => displayNATStatic(getRouter()));
  trie.register('display nat outbound', 'Display NAT outbound rules', () => displayNATOutbound(getRouter()));
  trie.register('display nat session', 'Display active NAT sessions', () => displayNATSession(getRouter()));
  trie.register('display nat statistics', 'Display NAT statistics', () => displayNATStatistics(getRouter()));
  trie.register('display nat all', 'Display all NAT information', () => [
    displayNATStatic(getRouter()),
    '',
    displayNATOutbound(getRouter()),
    '',
    displayNATSession(getRouter()),
    '',
    displayNATStatistics(getRouter()),
  ].join('\n'));
  trie.register('reset nat session', 'Clear all dynamic NAT sessions', () => {
    getRouter()._getNATEngine().clearTranslations();
    return 'NAT sessions cleared.';
  });
}

function displayNATStatic(router: Router): string {
  const engine = router._getNATEngine();
  const statics = engine.getStaticEntries();
  if (statics.length === 0) return 'No static NAT configured.';

  const lines = [
    ' Static NAT:',
    ' Global IP        Local IP          Protocol  GPort  LPort',
    ' ' + '-'.repeat(60),
  ];
  for (const e of statics) {
    const proto = e.protocol ?? '---';
    const gp = e.globalPort != null ? String(e.globalPort) : '---';
    const lp = e.localPort != null ? String(e.localPort) : '---';
    lines.push(` ${e.globalIP.padEnd(17)}${e.localIP.padEnd(18)}${proto.padEnd(10)}${gp.padEnd(7)}${lp}`);
  }
  return lines.join('\n');
}

function displayNATOutbound(router: Router): string {
  const engine = router._getNATEngine();
  const rules = engine.getDynamicRules();
  if (rules.length === 0) return 'No NAT outbound rules configured.';

  const lines = [
    ' NAT Outbound:',
    ' ACL       Type      Pool',
    ' ' + '-'.repeat(40),
  ];
  for (const r of rules) {
    const type = r.type === 'overload' ? 'overload' : 'pool';
    const pool = r.poolName ?? '---';
    lines.push(` ${String(r.aclId).padEnd(10)}${type.padEnd(10)}${pool}`);
  }
  return lines.join('\n');
}

function displayNATSession(router: Router): string {
  const entries = router._getNATEngine().getTranslations();
  const sessions = entries.filter(e => e.proto !== '---');
  if (sessions.length === 0) return 'No active NAT sessions.';

  const lines = [
    ' NAT Session Table Information:',
    ` Total sessions: ${sessions.length}`,
    '',
    ' Proto  Inside Local           Inside Global          Outside Global',
    ' ' + '-'.repeat(75),
  ];
  for (const s of sessions) {
    lines.push(` ${s.proto.padEnd(7)}${s.insideLocal.padEnd(23)}${s.insideGlobal.padEnd(23)}${s.outsideGlobal}`);
  }
  return lines.join('\n');
}

function displayNATStatistics(router: Router): string {
  const engine = router._getNATEngine();
  const counters = engine.getCounters();
  const timeouts = engine.getTimeouts();
  const total = engine.getTranslationCount();
  const statics = engine.getStaticEntries().length;

  return [
    ' NAT Statistics:',
    `  Total sessions:      ${total} (${statics} static, ${total - statics} dynamic)`,
    `  Translation hits:    ${counters.hits}`,
    `  Translation misses:  ${counters.misses}`,
    `  Expired sessions:    ${counters.expired}`,
    '',
    ' Session aging times (seconds):',
    `  TCP established:     ${timeouts.tcp / 1000}`,
    `  TCP SYN (half-open): ${timeouts.tcpHalfOpen / 1000}`,
    `  UDP:                 ${timeouts.udp / 1000}`,
    `  ICMP:                ${timeouts.icmp / 1000}`,
  ].join('\n');
}

// ─── Running-config helpers (for display current-configuration) ───────────────

export function runningConfigNATHuawei(router: Router, ifName: string): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];

  // Show nat inside/outside designation
  if (engine.isInsideInterface(ifName)) lines.push(' nat inside');
  if (engine.isOutsideInterface(ifName)) {
    // Show nat static entries (global config, not per-interface, but Huawei shows under interface)
    for (const e of engine.getStaticEntries()) {
      if (!e.protocol) {
        lines.push(` nat static global ${e.globalIP} inside ${e.localIP}`);
      } else {
        lines.push(` nat server protocol ${e.protocol} global ${e.globalIP} ${e.globalPort} inside ${e.localIP} ${e.localPort}`);
      }
    }
    // Show nat outbound rules
    for (const r of engine.getDynamicRules()) {
      if (r.type === 'overload') {
        lines.push(` nat outbound ${r.aclId}`);
      } else if (r.type === 'pool' && r.poolName) {
        lines.push(` nat outbound ${r.aclId} address-group ${r.poolName}`);
      }
    }
  }

  return lines;
}
