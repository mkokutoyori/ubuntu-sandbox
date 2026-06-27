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
import { isValidIPv4, tryIpToUint32 } from '../../../core/ip';

const stripQ = (s: string) => s?.replace(/^["']|["']$/g, '') ?? '';
const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

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

  trie.registerGreedy('nat outbound', 'Configure dynamic NAT/PAT outbound rule', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const aclId = args[0];
    const aclN = parseInt(aclId, 10);
    if (isNaN(aclN) || (aclN < 2000 || aclN > 3999)) return 'Error: ACL number must be a numbered ACL in range 2000-3999.';
    const engine = ctx.r()._getNATEngine();
    const router = ctx.r() as any;
    const aclEngine = router._getACLEngine?.() ?? router._acl;
    if (aclEngine?.hasAcl && !aclEngine.hasAcl(aclId)) return `Error: ACL ${aclId} does not exist.`;
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    engine.setOutsideInterface(ifName);
    const noPat = args.includes('no-pat');
    if (args[1]?.toLowerCase() === 'address-group' && args[2]) {
      const poolName = stripQ(args[2]);
      if (!engine.getPool(poolName)) return `Error: address-group ${poolName} does not exist.`;
      engine.addDynamicRule({ aclId, type: 'pool', poolName, interfaceName: ifName, ...(noPat ? { noPat: true } : {}) } as any);
    } else {
      engine.addDynamicRule({ aclId, type: 'overload', interfaceName: ifName });
    }
    return '';
  });

  // undo nat outbound <acl-number>
  trie.registerGreedy('undo nat outbound', 'Remove dynamic NAT outbound rule', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    ctx.r()._getNATEngine().removeDynamicRule(args[0]);
    return '';
  });

  trie.registerGreedy('nat server protocol', 'Configure NAT server (port forwarding)', (rawArgs) => {
    const args = rawArgs.map(stripQ);
    if (args.length < 7) return 'Error: Incomplete command.';
    const proto = args[0].toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp') return `Error: Unknown protocol "${args[0]}".`;
    if (args[1]?.toLowerCase() !== 'global') return 'Error: Expected "global" keyword.';
    const globalIP = args[2];
    if (!isValidIPv4(globalIP)) return `Error: Invalid IP address ${globalIP}.`;
    const globalPort = parseInt(args[3], 10);
    if (args[3]?.toLowerCase() === 'any') return 'Error: Wildcard global port not supported by nat server.';
    if (!validPort(globalPort)) return 'Error: Global port out of range.';
    if (args[4]?.toLowerCase() !== 'inside') return 'Error: Expected "inside" keyword.';
    const localIP = args[5];
    if (!isValidIPv4(localIP)) return `Error: Invalid local IP address ${localIP}.`;
    const localPort = parseInt(args[6], 10);
    if (!validPort(localPort)) return 'Error: Inside port out of range.';
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

  trie.registerGreedy('nat dns-map', 'Configure NAT DNS mapping', (args) => {
    if (args.length < 4) return '';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const engine = ctx.r()._getNATEngine() as any;
    (engine.dnsMappings ??= []).push({
      domain: args[0], globalIP: args[1],
      port: parseInt(args[2], 10), proto: args[3].toLowerCase(),
    });
    return '';
  });
}

export function registerHuaweiNATSystemCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  trie.registerGreedy('nat address-group', 'Configure NAT address pool', (rawArgs) => {
    const args = rawArgs.map(stripQ);
    if (args.length < 3) return 'Error: Incomplete command.';
    const idN = parseInt(args[0], 10);
    if (isNaN(idN) || idN < 0 || idN > 255) return 'Error: address-group ID out of range (0-255).';
    const name = args[0]; const start = args[1]; const end = args[2];
    if (!isValidIPv4(start)) return `Error: Invalid IP address ${start}.`;
    if (!isValidIPv4(end)) return `Error: Invalid IP address ${end}.`;
    const sN = tryIpToUint32(start)!, eN = tryIpToUint32(end)!;
    if (sN > eN) return 'Error: Start IP greater than end IP.';
    ctx.r()._getNATEngine().addPool({ name, startIP: start, endIP: end });
    return '';
  });

  trie.registerGreedy('undo nat address-group', 'Remove NAT address pool', (args) => {
    if (!args[0]) return '';
    ctx.r()._getNATEngine().removePool(args[0]);
    return '';
  });

  trie.registerGreedy('nat static global', 'Configure static NAT (system view)', (args) => {
    if (args.length < 3) return 'Error: Incomplete command.';
    const globalIP = args[0];
    if (args[1]?.toLowerCase() !== 'inside') return 'Error: Expected "inside" keyword.';
    const localIP = args[2];
    ctx.r()._getNATEngine().addStaticEntry({ localIP, globalIP });
    return '';
  });

  trie.register('nat static enable', 'Enable static NAT globally', () => {
    (ctx.r()._getNATEngine() as any).staticEnabled = true;
    return '';
  });
  trie.register('undo nat static enable', 'Disable static NAT', () => {
    (ctx.r()._getNATEngine() as any).staticEnabled = false;
    return '';
  });

  trie.registerGreedy('nat alg', 'Enable/disable NAT ALG for a protocol', (args) => {
    if (!args[0]) return 'Error: Missing protocol.';
    const proto = stripQ(args[0]).toLowerCase();
    const action = (stripQ(args[1] ?? 'enable')).toLowerCase();
    if (!['dns', 'ftp', 'tftp', 'h323', 'sip', 'rtsp', 'pptp'].includes(proto)) {
      return `Error: Unknown ALG protocol "${args[0]}".`;
    }
    if (!['enable', 'disable'].includes(action)) return 'Error: Expected enable or disable.';
    const router = ctx.r() as any;
    const alg: Map<string, boolean> = router._huaweiNatAlg ??= new Map();
    alg.set(proto, action === 'enable');
    return '';
  });
  trie.registerGreedy('undo nat alg', 'Disable NAT ALG for a protocol', (args) => {
    const proto = stripQ(args[0] ?? '').toLowerCase();
    const router = ctx.r() as any;
    router._huaweiNatAlg?.delete?.(proto);
    return '';
  });
}

// ─── Display Commands ─────────────────────────────────────────────────────────

export function registerHuaweiNATDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('display nat static', 'Display static NAT translations', () => displayNATStatic(getRouter()));
  trie.register('display nat outbound', 'Display NAT outbound rules', () => 'NAT Outbound Information:\n' + displayNATOutbound(getRouter()));
  trie.register('display nat session', 'Display active NAT sessions', () => 'NAT Session Table Information:\n' + displayNATSession(getRouter()));
  trie.register('display nat session all', 'Display all NAT sessions', () => 'NAT Session Table Information:\n' + displayNATSession(getRouter()));
  trie.registerGreedy('display nat session source', 'Display NAT sessions by source IP', () => 'NAT Session Table Information:\n' + displayNATSession(getRouter()));
  trie.registerGreedy('display nat session destination', 'Display NAT sessions by destination IP', () => 'NAT Session Table Information:\n' + displayNATSession(getRouter()));
  trie.register('display nat statistics', 'Display NAT statistics', () => 'NAT Statistics Information:\n' + displayNATStatistics(getRouter()));
  trie.registerGreedy('display nat statistics interface', 'Display NAT statistics on interface', (_args) => 'NAT Statistics Information:\n' + displayNATStatistics(getRouter()));
  trie.registerGreedy('display nat statistics slot', 'Display NAT statistics on slot', (_args) => 'NAT Statistics Information:\n' + displayNATStatistics(getRouter()));
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
  trie.register('reset nat session all', 'Clear all NAT sessions', () => {
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.registerGreedy('reset nat session inside', 'Clear NAT sessions matching inside IP', (args) => {
    if (!args[0] || !isValidIPv4(stripQ(args[0]))) return 'Error: Invalid inside IP address.';
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.register('display nat server', 'Display NAT server entries', () => 'NAT Server Information:\n' + displayNATServer(getRouter()));
  trie.registerGreedy('display nat session protocol', 'Display NAT sessions filtered by protocol', (_args) => {
    return 'NAT Session Table Information:\n' + displayNATSession(getRouter());
  });
  trie.register('display nat address-group', 'Display NAT address pools', () => {
    const pools = getRouter()._getNATEngine().getPools();
    const lines = ['NAT Address Group Information:'];
    if (pools.size === 0) { lines.push(' (no address groups configured)'); return lines.join('\n'); }
    lines.push(' Index  Pool Name   Start IP         End IP');
    let i = 0;
    for (const [, p] of pools) {
      lines.push(` ${String(i++).padEnd(7)}${p.name.padEnd(12)}${p.startIP.padEnd(17)}${p.endIP}`);
    }
    return lines.join('\n');
  });
  trie.register('display nat dns-map', 'Display NAT DNS mappings', () => {
    const engine = getRouter()._getNATEngine() as any;
    const m = engine.dnsMappings as Array<{ domain: string; globalIP: string; port: number; proto: string }> | undefined;
    if (!m || m.length === 0) return 'No NAT DNS mappings configured.';
    return m.map(x => ` ${x.domain.padEnd(24)}${x.globalIP.padEnd(17)}${x.port}/${x.proto}`).join('\n');
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
  if (rules.length === 0) return ' (no outbound rules configured)';

  const lines = [
    ' ACL       Type      Pool                Flags',
    ' ' + '-'.repeat(55),
  ];
  for (const r of rules) {
    const type = r.type === 'overload' ? 'easy-ip' : 'pool';
    const pool = r.poolName ?? '---';
    const noPat = (r as any).noPat ? 'no-pat' : '';
    lines.push(` ${String(r.aclId).padEnd(10)}${type.padEnd(10)}${pool.padEnd(20)}${noPat}`);
  }
  return lines.join('\n');
}

function displayNATServer(router: Router): string {
  const engine = router._getNATEngine();
  const entries = engine.getStaticEntries().filter(e => e.protocol);
  if (entries.length === 0) return ' (no NAT server entries configured)';
  const lines = [' Proto  Global IP:Port              Inside IP:Port'];
  for (const e of entries) {
    lines.push(` ${(e.protocol ?? '---').padEnd(6)} ${e.globalIP}:${e.globalPort ?? 0}              ${e.localIP}:${e.localPort ?? 0}`);
  }
  return lines.join('\n');
}

function displayNATSession(router: Router): string {
  const entries = router._getNATEngine().getTranslations();
  const sessions = entries.filter(e => e.proto !== '---');
  const lines: string[] = [` Total sessions: ${sessions.length}`];
  if (sessions.length > 0) {
    lines.push('');
    lines.push(' Proto  Inside Local           Inside Global          Outside Global');
    lines.push(' ' + '-'.repeat(75));
    for (const s of sessions) {
      lines.push(` ${s.proto.padEnd(7)}${s.insideLocal.padEnd(23)}${s.insideGlobal.padEnd(23)}${s.outsideGlobal}`);
    }
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
