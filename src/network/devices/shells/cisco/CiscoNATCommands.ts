import { simulationNowMs } from '@/network/core/SystemClock';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { prefixLengthToMaskUint32, uint32ToIp, isValidIPv4 } from '../../../core/ip';
import type { Router } from '../../Router';
import type { CommandSpec } from '@/cli/CommandTable';
import type { NatHost } from '@/cli/commands/nat/natHost';
import { natInterfaceFamily } from '@/cli/commands/nat/natInterfaceFamily';
import { NAT_TIMEOUT_KEYWORDS } from '@/cli/commands/nat/natConfigFamily';
import { DEFAULT_NAT_TIMEOUTS } from '../../router/NATEngine';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { MODES_INTERFACE } from './CiscoConfigCommands';
import type { VrfHost } from './ciscoVrfStore';
import { vrfInterfaceSpecs } from './vrfSpecs';

function cidrToMask(cidr: number): string {
  return uint32ToIp(prefixLengthToMaskUint32(cidr));
}

export function natHostOf(ctx: CiscoShellContext): NatHost {
  return {
    router: () => ctx.r(),
    engine: () => ctx.r()._getNATEngine(),
    selectedInterface: () => ctx.getSelectedInterface(),
    resolveInterface: (name) => ctx.resolveInterfaceName(name),
    resolveHostName: (name) => ctx.r()._getHostsTable().resolve(name) ?? name,
    portOf: (name) => {
      const port = ctx.r().getPort?.(name);
      return port
        ? { address: port.getIPAddress?.()?.toString(), up: port.getIsUp() }
        : undefined;
    },
    vrfExists: (name) => ctx.r()._vrfs?.has(name) === true,
    vrfInterfaces: (name) => ctx.r()._vrfs?.get(name)?.interfaces,
  };
}

interface VrfTable {
  _vrfs?: Map<string, { name: string; interfaces: Set<string> }>;
  _ifaceVrf?: Map<string, string>;
}

export function interfaceVrfName(router: Router, iface: string): string | undefined {
  return (router as unknown as VrfTable)._ifaceVrf?.get(iface);
}

export function natInterfaceSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return [
    ...natInterfaceFamily(() => natHostOf(ctx), MODES_INTERFACE),
    ...vrfInterfaceSpecs(() => ({
      vrfHost: () => ctx.r() as unknown as VrfHost,
      selectedInterface: () => ctx.getSelectedInterface(),
      interfaceVrfTable: () => {
        const t = ctx.r() as unknown as VrfTable;
        return (t._ifaceVrf ??= new Map());
      },
      interfaceAddress: (iface) =>
        ctx.r().getPort?.(iface)?.getIPAddress?.()?.toString(),
      unconfigureInterface: (iface) => { ctx.r().unconfigureInterface(iface); },
    }), MODES_INTERFACE),
  ];
}

function staticTranslationRows(engine: ReturnType<Router['_getNATEngine']>): string[] {
  const lines: string[] = [];
  for (const ns of engine.getStaticEntries().filter(e => e.isNetwork)) {
    const last = ns.localIP.split('.').slice(-1)[0];
    const prefix = ns.globalIP.split('.').slice(0, 3).join('.');
    const exampleGlobal = padToWidth(`${prefix}.${last}`, 23);
    const exampleLocal = padToWidth(ns.localIP, 23);
    const mask = cidrToMask(ns.prefixLen ?? 24);
    lines.push(`---  ${exampleGlobal}${exampleLocal}---                    ---`);
    lines.push(`     ${ns.globalIP}/${ns.prefixLen} mask ${mask}   ${ns.localIP}/${ns.prefixLen} mask ${mask}`);
  }
  for (const o of engine.getOutsideStaticEntries()) {
    lines.push(`---  ---                    ---                    ${padToWidth(o.outsideLocal, 23)}${o.outsideGlobal}`);
  }
  return lines;
}

export function showNATTranslations(router: Router): string {
  const engine = router._getNATEngine();
  engine.purgeStale();
  const entries = engine.getTranslations();
  const extraRows = staticTranslationRows(engine);

  const header = 'Pro  Inside global          Inside local           Outside local          Outside global';
  if (entries.length === 0 && extraRows.length === 0) {
    return `${header}\nNo NAT translations.`;
  }
  const lines = [header];
  for (const e of entries) {
    const proto = padToWidth(e.proto, 4);
    const ig = padToWidth(e.insideGlobal, 23);
    const il = padToWidth(e.insideLocal, 23);
    const ol = padToWidth(e.outsideLocal, 23);
    const og = e.outsideGlobal;
    lines.push(`${proto} ${ig}${il}${ol}${og}`);
  }
  lines.push(...extraRows);
  return lines.join('\n');
}

/** `Xd:XXh:XXm:XXs` duration format used by `show ip nat translations verbose`. */
function formatNatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${days}d:${String(hours).padStart(2, '0')}h:${String(mins).padStart(2, '0')}m:${String(secs).padStart(2, '0')}s`;
}

export function showNATTranslationsVerbose(router: Router, filterArgs: string[] = []): string {
  const cleaned = filterArgs.map(a => a.replace(/^["']|["']$/g, ''));
  let filterIP: string | null = null;
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i].toLowerCase();
    if ((t === 'local' || t === 'global') && cleaned[i + 1]) {
      filterIP = cleaned[i + 1];
      if (!isValidIPv4(filterIP)) return `% Invalid filter IP ${filterIP}.`;
    }
  }
  const engine = router._getNATEngine();
  engine.purgeStale();
  let entries = engine.getTranslations();
  if (filterIP) entries = entries.filter(e => e.insideLocal.includes(filterIP!) || e.insideGlobal.includes(filterIP!));
  const header = `Pro  Inside global          Inside local           Outside local          Outside global`;
  const extraRows = filterIP ? [] : staticTranslationRows(engine);
  if (entries.length === 0 && extraRows.length === 0) return `${header}\nNo NAT translations.`;

  const lines: string[] = [];
  lines.push(header);
  const now = simulationNowMs();
  for (const e of entries) {
    lines.push(`${padToWidth(e.proto, 4)} ${padToWidth(e.insideGlobal, 23)}${padToWidth(e.insideLocal, 23)}${padToWidth(e.outsideLocal, 23)}${e.outsideGlobal}`);
    if (e.createdAtMs !== undefined && e.lastUsedMs !== undefined && e.timeoutMs !== undefined) {
      const create = formatNatDuration(now - e.createdAtMs);
      const use = formatNatDuration(now - e.lastUsedMs);
      const left = formatNatDuration(Math.max(0, e.timeoutMs - (now - e.lastUsedMs)));
      lines.push(`    create: ${create}, use: ${use}, left: ${left}`);
    } else {
      lines.push(`    create: 0d:00h:00m:00s, use: 0d:00h:00m:00s, left: --`);
    }
    if (e.inputIface) lines.push(`    input iface: ${e.inputIface}`);
    lines.push(`    flags: ${e.dynamicBinding ? 'none' : e.proto === '---' ? 'static' : 'extended'}`);
    lines.push('');
  }
  lines.push(...extraRows);
  return lines.join('\n').trimEnd();
}

export function showNATStatistics(router: Router): string {
  const engine = router._getNATEngine();
  const sessions = engine.getSessions();
  const dynamicFlows = sessions.filter(s => s.viaStatic !== true).length;
  const dynamicSessions = dynamicFlows + engine.getHostBindings().length;
  const statics = engine.getStaticEntries().length + (sessions.length - dynamicFlows);
  const dynamic = engine.getDynamicRules().length;
  const total = engine.getTranslationCount();
  const inside = [...engine.getInsideInterfaces()].join(', ') || 'none';
  const outside = [...engine.getOutsideInterfaces()].join(', ') || 'none';
  const counters = engine.getCounters();
  const timeouts = engine.getTimeouts();
  const maxEntries = engine.getMaxEntries?.();
  const hasOverload = engine.getDynamicRules().some(r => r.type === 'overload');

  const addressNumber = (ip: string): number => ip.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
  const maskOf = (p: { netmask?: string; prefixLength?: number }): string => {
    if (p.netmask) return p.netmask;
    const bits = p.prefixLength ?? 24;
    const value = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
  };
  const mappingLines: string[] = [];
  engine.getDynamicRules().forEach((rule, index) => {
    const selector = rule.routeMap !== undefined ? `route-map ${rule.routeMap}` : `access-list ${rule.aclId}`;
    const id = `[Id: ${index + 1}]`;
    if (rule.type === 'overload') {
      const ifName = rule.interfaceName ?? '';
      const ifIp = router.getPort?.(ifName)?.getIPAddress?.()?.toString();
      const refcount = sessions.filter(s => s.viaStatic !== true && s.globalIP === ifIp).length;
      mappingLines.push(`${id} ${selector} interface ${ifName} refcount ${refcount}`);
      return;
    }
    const pool = rule.poolName !== undefined ? engine.getPool(rule.poolName) : undefined;
    if (!pool) return;
    const start = addressNumber(pool.startIP);
    const end = addressNumber(pool.endIP);
    const inPool = sessions.filter(s => s.viaStatic !== true && addressNumber(s.globalIP) >= start && addressNumber(s.globalIP) <= end);
    const allocated = rule.overload
      ? new Set(inPool.map(s => s.globalIP)).size
      : engine.getHostBindings().filter(b => b.poolName === pool.name).length;
    const total = end - start + 1;
    mappingLines.push(`${id} ${selector} pool ${pool.name}${rule.overload ? ' overload' : ''} refcount ${inPool.length}`);
    mappingLines.push(` pool ${pool.name}: netmask ${maskOf(pool)}`);
    mappingLines.push(`\tstart ${pool.startIP} end ${pool.endIP}`);
    mappingLines.push(`\ttype generic, total addresses ${total}, allocated ${allocated} (${Math.round((allocated * 100) / total)}%), misses ${engine.getPoolMisses(pool.name)}`);
  });

  const staticEntries = engine.getStaticEntries();

  return [
    `Total active translations: ${total} (${statics} static, ${dynamicSessions} dynamic; ${sessions.length} extended)`,
    `Peak translations: ${engine.getPeakTranslationCount()}`,
    `Total translations: ${total}`,
    `Static translations: ${statics}`,
    `Dynamic translations: ${dynamicSessions}`,
    `Translation errors: ${counters.errors}`,
    `Outside interfaces:  ${outside}`,
    `Inside interfaces:   ${inside}`,
    `Hits: ${counters.hits}  Misses: ${counters.misses}`,
    ...(counters.expired > 0 ? [`Expired translations: ${counters.expired}`] : []),
    `Session timeouts (seconds): tcp ${timeouts.tcp / 1000}  udp ${timeouts.udp / 1000}  icmp ${timeouts.icmp / 1000}  syn ${timeouts.tcpHalfOpen / 1000}`,
    ...(hasOverload ? ['Overloaded mappings: yes'] : []),
    ...(maxEntries != null ? [`max-entries ${maxEntries}`, ...(sessions.length >= maxEntries ? ['Limit reached: new translations blocked'] : [])] : []),
    `Static mappings:`,
    ...(staticEntries.length === 0 ? ['-- No static NAT entries configured --'] :
      staticEntries.map(e => e.protocol
        ? ` -- static  ${e.protocol} ${e.localIP} ${e.localPort ?? ''}  ${e.globalIP} ${e.globalPort ?? ''}  refcount ${e.hitCount ?? 0}`
        : ` -- static  ${e.localIP}  ${e.globalIP}  refcount ${e.hitCount ?? 0}`
      )),
    `Dynamic mappings:`,
    ...(dynamic === 0 ? ['-- No dynamic NAT rules configured --'] : ['-- Inside Source', ...mappingLines]),
    `Total doors: ${engine.getAlgDoors()}`,
    `Appl doors: ${engine.getAlgDoors()}`,
    `Normal doors: 0`,
    `Queued Packets: 0`,
  ].join('\n');
}

// ─── Running-Config helpers ───────────────────────────────────────────────────

export function runningConfigNAT(router: Router): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];

  for (const [, pool] of engine.getPools()) {
    const tail = pool.netmask != null
      ? `netmask ${pool.netmask}`
      : `prefix-length ${pool.prefixLength ?? 24}`;
    lines.push(`ip nat pool ${pool.name} ${pool.startIP} ${pool.endIP} ${tail}`);
  }

  for (const e of engine.getStaticEntries()) {
    if (e.rawConfig) { lines.push(e.rawConfig); continue; }
    if (e.isNetwork) {
      lines.push(`ip nat inside source static network ${e.localIP} ${e.globalIP} /${e.prefixLen}`);
    } else if (!e.protocol) {
      lines.push(`ip nat inside source static ${e.localIP} ${e.globalIP}`);
    } else {
      lines.push(`ip nat inside source static ${e.protocol} ${e.localIP} ${e.localPort} ${e.globalIP} ${e.globalPort}`);
    }
  }
  for (const o of engine.getOutsideStaticEntries()) {
    lines.push(`ip nat outside source static ${o.outsideGlobal} ${o.outsideLocal}`);
  }
  for (const r of engine.getDynamicRules()) {
    const vrfTail = r.vrf ? ` vrf ${r.vrf}` : '';
    const selector = r.routeMap !== undefined ? `route-map ${r.routeMap}` : `list ${r.aclId}`;
    if (r.type === 'overload') {
      const iface = r.interfaceName ?? [...engine.getOutsideInterfaces()][0] ?? 'GigabitEthernet0/1';
      lines.push(`ip nat inside source ${selector} interface ${iface} overload${vrfTail}`);
    } else if (r.type === 'pool' && r.poolName) {
      lines.push(`ip nat inside source ${selector} pool ${r.poolName}${r.overload ? ' overload' : ''}${vrfTail}`);
    }
  }

  if (engine.getMaxEntries() !== null) lines.push(`ip nat translation max-entries ${engine.getMaxEntries()}`);
  if (engine.getMaxEntriesAllHost() !== null) lines.push(`ip nat translation max-entries all-host ${engine.getMaxEntriesAllHost()}`);
  for (const [host, limit] of engine.getMaxEntriesByHost()) lines.push(`ip nat translation max-entries host ${host} ${limit}`);
  if (engine.isTranslationLogging()) lines.push('ip nat log translations syslog');

  // Non-default timeouts
  const t = engine.getTimeouts();
  for (const [keyword, field] of NAT_TIMEOUT_KEYWORDS) {
    if (t[field] !== DEFAULT_NAT_TIMEOUTS[field]) lines.push(`ip nat translation ${keyword} ${t[field] / 1000}`);
  }

  return lines;
}

export function runningConfigInterfaceNAT(router: Router, ifName: string): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];
  if (engine.isInsideInterface(ifName)) lines.push(' ip nat inside');
  if (engine.isOutsideInterface(ifName)) lines.push(' ip nat outside');
  return lines;
}
