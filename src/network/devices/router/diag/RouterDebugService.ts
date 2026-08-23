export type DebugCategory =
  | 'crypto.isakmp'
  | 'crypto.ipsec'
  | 'ip.ospf.adj'
  | 'ip.ospf.events'
  | 'ip.ospf.spf'
  | 'ip.ospf.hello'
  | 'ip.ospf.packet'
  | 'ip.ospf.lsa-generation'
  | 'ip.rip'
  | 'ip.eigrp'
  | 'ip.bgp'
  | 'ip.routing'
  | 'ip.icmp'
  | 'ip.packet'
  | 'ip.tcp'
  | 'ip.udp'
  | 'ip.nat'
  | 'ip.arp'
  | 'interface'
  | 'ip.dhcp.server'
  | 'ip.ssh'
  | 'ip.domain'
  | 'ip.nhrp'
  | 'standby'
  | 'vrrp'
  | 'glbp'
  | 'track'
  | 'ip.sla.trace'
  | 'ip.sla.error'
  | 'aaa.authentication'
  | 'aaa.authorization'
  | 'aaa.accounting'
  | 'radius'
  | 'tacacs'
  | 'ntp.events'
  | 'ntp.packets'
  | 'lldp.packets'
  | 'cdp.packets'
  | 'ip.pim'
  | 'vxlan'
  | 'port-security'
  | 'ipv6.packet'
  | 'ipv6.nd'
  | 'ipv6.icmp'
  | 'mac'
  | 'link'
  | 'stp.events'
  | 'stp.bpdu';

import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener, type DebugLineJournal, type TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';
import { CliInvalidInput } from '@/network/devices/shells/cli/CliDiagnostic';
import { ospfHelloMismatchLines } from '@/network/ospf/events';

const OSPF_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'Hello', 2: 'Data Description', 3: 'LS Request', 4: 'LS Update', 5: 'LS Ack',
};

function ospfTypeName(code: number | undefined): string {
  return OSPF_TYPE_NAMES[code ?? 0] ?? 'unknown';
}

function maskToCidr(mask: string): number {
  if (/^\d+$/.test(mask)) return Number(mask);
  return mask.split('.').reduce((n, o) => n + (Number(o).toString(2).match(/1/g)?.length ?? 0), 0);
}

function shortIface(name: string): string {
  const m = /^([A-Za-z]+)(\d.*)$/.exec(name);
  if (!m) return name;
  const prefix = m[1].startsWith('Gigabit') ? 'Gi'
    : m[1].startsWith('FastEther') ? 'Fa'
    : m[1].startsWith('TenGigabit') ? 'Te'
    : m[1].startsWith('Ether') ? 'Et'
    : m[1].slice(0, 2);
  return `${prefix}${m[2]}`;
}

export function toCiscoMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return mac;
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
}

export interface DebugFlag {
  category: DebugCategory;
  enabledAtMs: number;
  /** ACL name/number the flag is filtered by, when one was given. */
  scope?: string;
  /** `detail` keyword — an independent axis from the ACL, so it needs
   *  its own field: `debug ip packet 100 detail` carries both. */
  detail?: boolean;
}

export interface DebugPacketFacts {
  src: string;
  dst: string;
  proto: number;
  srcPort?: number;
  dstPort?: number;
}

const DEBUG_CATEGORIES: ReadonlySet<string> = new Set<string>([
  'crypto.isakmp', 'crypto.ipsec',
  'ip.ospf.adj', 'ip.ospf.events', 'ip.ospf.spf', 'ip.ospf.hello',
  'ip.ospf.packet', 'ip.ospf.lsa-generation',
  'ip.rip', 'ip.eigrp', 'ip.bgp', 'ip.routing', 'ip.icmp', 'ip.packet',
  'ip.tcp', 'ip.udp', 'ip.nat', 'ip.arp', 'interface', 'ip.dhcp.server',
  'ip.ssh', 'ip.domain', 'ip.nhrp', 'standby', 'vrrp', 'glbp', 'track',
  'ip.sla.trace', 'ip.sla.error',
  'aaa.authentication', 'aaa.authorization', 'aaa.accounting',
  'radius', 'tacacs', 'ntp.events', 'ntp.packets',
  'lldp.packets', 'cdp.packets', 'ip.pim', 'vxlan', 'port-security',
  'ipv6.packet', 'ipv6.nd', 'ipv6.icmp', 'mac', 'link', 'stp.events', 'stp.bpdu',
]);

const ALIAS: ReadonlyArray<readonly [RegExp, DebugCategory]> = [
  [/^(ip\.)?arp$/, 'ip.arp'],
  [/^cdp(\.|\s|$)/, 'cdp.packets'],
  [/^lldp(\.|\s|$)/, 'lldp.packets'],
  [/^port[-_ ]security$/, 'port-security'],
  [/^(ip[. ])?dhcp/, 'ip.dhcp.server'],
  [/^(ip[. ])?domain$/, 'ip.domain'],
  [/^vxlan$/, 'vxlan'],
  [/^mac([- ]address-table)?$/, 'mac'],
  [/^link([- ]state)?$/, 'link'],
  [/^spanning[- ]tree\s*bpdu/, 'stp.bpdu'],
  [/^spanning[- ]tree\s*event/, 'stp.events'],
  [/^bpdu$/, 'stp.bpdu'],
  [/^events?$/, 'stp.events'],
];

export type DebugPlatform = 'router' | 'switch';

const SWITCH_ONLY: ReadonlySet<string> = new Set(['mac', 'link', 'stp.events', 'stp.bpdu']);

const SWITCH_CATEGORIES: ReadonlySet<string> = new Set<string>([
  'mac', 'link', 'stp.events', 'stp.bpdu',
  'ip.arp', 'cdp.packets', 'lldp.packets', 'port-security',
  'ip.dhcp.server', 'vxlan', 'interface',
]);

export function categoryOnPlatform(category: string, platform: DebugPlatform): boolean {
  return platform === 'switch'
    ? SWITCH_CATEGORIES.has(category)
    : !SWITCH_ONLY.has(category);
}

export function debugCategoriesFor(arg: string): DebugCategory[] | null {
  const w = arg.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!w) return null;
  if (/^spanning[- ]tree( all)?$/.test(w)) return ['stp.events', 'stp.bpdu'];
  for (const [re, cat] of ALIAS) if (re.test(w)) return [cat];
  if (DEBUG_CATEGORIES.has(w as DebugCategory)) return [w as DebugCategory];
  return null;
}

export class RouterDebugService implements TerminalDebugSource {
  constructor(private readonly platform: DebugPlatform = 'router') {}

  private readonly flags: Map<DebugCategory, DebugFlag> = new Map();
  private readonly broadcast = new DebugBroadcast();

  static flagLabel(flag: { category: DebugCategory; scope?: string; detail?: boolean }): string {
    if (flag.category === 'interface' && flag.scope) {
      return `Interface ${flag.scope} debugging is on`;
    }
    const portee = flag.scope ? ` for access list ${flag.scope}` : '';
    return `${RouterDebugService.label(flag.category)} debugging is on`
      + `${portee}${flag.detail ? ' (detailed)' : ''}`;
  }

  knows(category: DebugCategory): boolean {
    return categoryOnPlatform(category, this.platform);
  }

  private requirePlatform(category: DebugCategory): void {
    if (!this.knows(category)) throw new CliInvalidInput();
  }

  enable(category: DebugCategory, scope?: string, detail = false): string {
    this.requirePlatform(category);
    const flag = { category, enabledAtMs: Date.now(), scope, detail };
    this.flags.set(category, flag);
    return RouterDebugService.flagLabel(flag);
  }

  disable(category: DebugCategory): string {
    this.requirePlatform(category);
    this.flags.delete(category);
    return `${RouterDebugService.label(category)} debugging is off`;
  }

  recognizes(arg: string): boolean {
    const cats = debugCategoriesFor(arg);
    return cats !== null && cats.every((c) => categoryOnPlatform(c, this.platform));
  }

  enableScope(arg: string): string {
    const cats = debugCategoriesFor(arg);
    if (!cats || !this.recognizes(arg)) {
      throw new CliInvalidInput({ token: arg.trim().split(/\s+/)[0] });
    }
    let out = '';
    for (const c of cats) out = this.enable(c);
    return cats.length > 1 ? `${RouterDebugService.label(cats[0])} debugging is on` : out;
  }

  disableScope(arg: string): string {
    const cats = debugCategoriesFor(arg);
    if (!cats || !this.recognizes(arg)) {
      throw new CliInvalidInput({ token: arg.trim().split(/\s+/)[0] });
    }
    let out = '';
    for (const c of cats) out = this.disable(c);
    return cats.length > 1 ? `${RouterDebugService.label(cats[0])} debugging is off` : out;
  }

  isStpEnabled(): boolean {
    return this.flags.has('stp.events') || this.flags.has('stp.bpdu');
  }

  isEnabled(category: DebugCategory): boolean { return this.flags.has(category); }

  hasAnyFlag(): boolean { return this.flags.size > 0; }

  list(): readonly DebugFlag[] {
    return [...this.flags.values()].sort((a, b) => a.category.localeCompare(b.category));
  }

  /**
   * `debug ipv6 nd` and `debug ipv6 icmp` are separate IOS commands, and
   * they were neither: the greedy handler took `nd`/`icmp` for an ACCESS
   * LIST name and answered `debugging is on for access list nd`. Both
   * read the same frame `debug ipv6 packet` already observes — the
   * ICMPv6 type is what tells Neighbor Discovery from the rest, so
   * nothing new is hooked and the three cannot drift.
   */
  private tracerIcmpv6(
    v6: { nextHeader?: number; payload?: unknown; sourceIP?: { toString(): string }; destinationIP?: { toString(): string } },
    dir: string,
    iface: string,
  ): void {
    if (v6.nextHeader !== 58) return;
    const icmp = v6.payload as {
      type?: string; icmpType?: string;
      ndp?: { targetAddress?: { toString(): string } };
    } | undefined;
    if (icmp?.type !== 'icmpv6' || !icmp.icmpType) return;

    const verbe = dir === 'sent' ? 'Sending' : 'Received';
    const src = v6.sourceIP?.toString?.() ?? '?';
    const dst = v6.destinationIP?.toString?.() ?? '?';
    const cible = icmp.ndp?.targetAddress?.toString?.();

    switch (icmp.icmpType) {
      case 'neighbor-solicitation':
      case 'neighbor-advertisement': {
        const sigle = icmp.icmpType === 'neighbor-solicitation' ? 'NS' : 'NA';
        this.emit('ipv6.nd',
          `ICMPv6-ND: ${verbe} ${sigle} for ${cible ?? dst} on ${iface}`);
        return;
      }
      case 'router-solicitation':
      case 'router-advertisement': {
        const sigle = icmp.icmpType === 'router-solicitation' ? 'RS' : 'RA';
        this.emit('ipv6.nd', `ICMPv6-ND: ${verbe} ${sigle} on ${iface}`);
        return;
      }
      default:
        this.emit('ipv6.icmp',
          `ICMPv6: ${verbe} ${icmp.icmpType} ${dir === 'sent' ? 'to' : 'from'} `
          + `${dir === 'sent' ? dst : src} on ${iface}`);
    }
  }

  private static readonly ALL: ReadonlyArray<DebugCategory> = [
    'ip.packet', 'ip.icmp', 'ip.arp', 'ip.routing', 'ip.nat', 'ip.tcp', 'ip.udp',
    'ip.ospf.adj', 'ip.ospf.events', 'ip.ospf.spf', 'ip.ospf.hello',
    'ip.ospf.packet', 'ip.ospf.lsa-generation', 'ip.dhcp.server',
    'ip.sla.trace', 'ip.sla.error', 'track', 'interface', 'ipv6.packet',
    'ipv6.nd', 'ipv6.icmp',
    'cdp.packets', 'lldp.packets', 'ip.pim', 'vxlan',
    'crypto.isakmp', 'crypto.ipsec',
  ];

  enableAll(): string {
    const now = Date.now();
    const tout = this.platform === 'switch'
      ? [...SWITCH_CATEGORIES] as DebugCategory[]
      : RouterDebugService.ALL.filter((c) => categoryOnPlatform(c, this.platform));
    for (const c of tout) {
      if (!this.flags.has(c)) this.flags.set(c, { category: c, enabledAtMs: now });
    }
    return 'All possible debugging has been turned on';
  }

  disableAll(): string {
    this.flags.clear();
    return 'All possible debugging has been turned off';
  }

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  subscriberCount(): number { return this.broadcast.subscriberCount(); }

  /**
   * Re-read `logging rate-limit` before each line, so an operator who
   * lowers the budget mid-flood sees it take effect at once instead of
   * having to bounce the debug.
   */
  private rateLimitResolver: (() => void) | null = null;
  setRateLimitResolver(fn: (() => void) | null): void { this.rateLimitResolver = fn; }

  /**
   * `debug condition interface X` / `debug condition vrf Y`. On IOS a
   * condition is global: every debug already on, and every one enabled
   * afterwards, inherits it. A line that carries no evidence either way
   * is dropped — a condition the operator asked for must not be widened
   * by our own inability to classify a line.
   */
  /**
   * Une condition porte un NUMÉRO, et pas seulement un rang.
   *
   * IOS annonce `Condition 1 set` et on la retire par `no debug
   * condition 1` — le numéro est donc un identifiant, pas une position.
   * Il était dérivé de l'index du tableau : après avoir retiré la
   * première de trois conditions, les deux restantes se renumérotaient,
   * et `show debug condition` désignait sous le numéro 1 une condition
   * que l'opérateur avait vue sous le numéro 2. Le numéro est désormais
   * attribué à la création et ne bouge plus.
   *
   * Le plus petit numéro libre est réutilisé, comme sur IOS où ce sont
   * des emplacements : après avoir tout retiré, la suivante est de
   * nouveau la 1.
   */
  private readonly conditions: Array<{ id: number; kind: 'interface' | 'vrf' | 'ip'; value: string }> = [];

  private allocateConditionId(): number {
    const pris = new Set(this.conditions.map((c) => c.id));
    let n = 1;
    while (pris.has(n)) n++;
    return n;
  }

  addCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string {
    const deja = this.conditions.find(
      (c) => c.kind === kind && c.value.toLowerCase() === value.toLowerCase());
    if (deja) return `Condition ${deja.id} set`;
    const id = this.allocateConditionId();
    this.conditions.push({ id, kind, value });
    this.conditions.sort((a, b) => a.id - b.id);
    return `Condition ${id} set`;
  }

  removeCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string {
    const i = this.conditions.findIndex(
      (c) => c.kind === kind && c.value.toLowerCase() === value.toLowerCase());
    if (i < 0) return `% Condition not found`;
    const id = this.conditions[i].id;
    this.conditions.splice(i, 1);
    return `Condition ${id} has been removed`;
  }

  /** `no debug condition <n>` — par numéro, la forme que le tutoriel emploie. */
  removeConditionById(id: number): string {
    const i = this.conditions.findIndex((c) => c.id === id);
    if (i < 0) return `% Condition ${id} was not set`;
    this.conditions.splice(i, 1);
    return `Condition ${id} has been removed`;
  }

  clearConditions(): void { this.conditions.length = 0; }

  listConditions(): ReadonlyArray<{ id: number; kind: 'interface' | 'vrf' | 'ip'; value: string }> {
    return this.conditions;
  }

  /** Does this line satisfy every standing condition? */
  private passesConditions(line: string): boolean {
    for (const c of this.conditions) {
      const needle = c.value.toLowerCase();
      if (!line.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  /** Master switch: `no logging on` mutes every channel, flags intact. */
  setOutputGate(gate: (() => boolean) | null): void { this.broadcast.setOutputGate(gate); }

  /** `logging rate-limit N` — console budget for debug output. */
  setRateLimit(linesPerSecond: number): void { this.broadcast.setRateLimit(linesPerSecond); }
  getRateLimit(): number { return this.broadcast.getRateLimit(); }
  /** Lines the rate limiter dropped since boot. */
  getDroppedCount(): number { return this.broadcast.getDroppedCount(); }
  /** Report the current window's drops now, rather than on the next line. */
  flushDrops(): void { this.broadcast.flushDrops(); }

  private aclMatchFn?: (aclName: string, line: string, faits?: DebugPacketFacts) => boolean;
  private readonly categoryRenderers = new Map<DebugCategory, () => string>();

  setCategoryRenderer(category: DebugCategory, render: () => string): void {
    this.categoryRenderers.set(category, render);
  }

  setAclFilterEvaluator(fn: (aclName: string, line: string, faits?: DebugPacketFacts) => boolean): void {
    this.aclMatchFn = fn;
  }

  setJournal(journal: DebugLineJournal | null): void { this.broadcast.setJournal(journal); }

  private emit(category: DebugCategory, line: string, faits?: DebugPacketFacts): void {
    const flag = this.flags.get(category);
    if (!flag) return;
    this.rateLimitResolver?.();
    if (!this.passesConditions(line)) return;
    if (flag.scope && this.aclMatchFn && !this.aclMatchFn(flag.scope, line, faits)) return;
    this.broadcast.fan(line);
  }

  private static faitsDe(ip: { src: string; dst: string; proto: number; transport?: unknown }): DebugPacketFacts {
    const t = ip.transport as { sourcePort?: number; destinationPort?: number } | undefined;
    return {
      src: ip.src, dst: ip.dst, proto: ip.proto,
      srcPort: t?.sourcePort, dstPort: t?.destinationPort,
    };
  }

  private readonly tcpVues = new Map<string, string>();

  private tracerTcp(ip: { src: string; dst: string; transport?: unknown }, dir: string, faits?: DebugPacketFacts): void {
    const t = ip.transport as { sourcePort?: number; destinationPort?: number;
      sequenceNumber?: number; acknowledgementNumber?: number;
      flags?: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean } } | undefined;
    if (!t) return;
    const f = t.flags ?? {};
    const nom = f.rst ? 'RST'
      : f.syn && f.ack ? 'SYN-ACK'
      : f.syn ? 'SYN'
      : f.fin && f.ack ? 'FIN-ACK'
      : f.fin ? 'FIN'
      : f.ack ? 'ACK' : null;
    if (!nom) return;
    const verbe = dir === 'rcvd' ? 'received' : 'sending';
    if (nom === 'RST') {
      this.emit('ip.tcp', 'TCP: received RST', faits);
      return;
    }
    this.emit('ip.tcp',
      `TCP: ${verbe} ${nom}, seq ${t.sequenceNumber ?? 0}, ack ${t.acknowledgementNumber ?? 0}`, faits);

    const cle = [ip.src, t.sourcePort, ip.dst, t.destinationPort].join(':');
    const inverse = [ip.dst, t.destinationPort, ip.src, t.sourcePort].join(':');
    if (nom === 'SYN-ACK') this.tcpVues.set(inverse, 'syn-ack');
    else if (nom === 'ACK' && this.tcpVues.get(cle) === 'syn-ack') {
      this.tcpVues.delete(cle);
      this.emit('ip.tcp', `TCP: Connection to ${ip.dst}:${t.destinationPort} ESTABLISHED`, faits);
    }
  }

  private static ligneTransport(proto: number, t: unknown): string | null {
    if (proto === 6) {
      const s = t as { sourcePort?: number; destinationPort?: number; sequenceNumber?: number;
        acknowledgementNumber?: number; windowSize?: number;
        flags?: { syn?: boolean; ack?: boolean; fin?: boolean; rst?: boolean; psh?: boolean; urg?: boolean } };
      const f = s?.flags ?? {};
      const noms = [
        f.syn ? 'SYN' : '', f.ack ? 'ACK' : '', f.fin ? 'FIN' : '',
        f.rst ? 'RST' : '', f.psh ? 'PSH' : '', f.urg ? 'URG' : '',
      ].filter(Boolean).join(' ');
      return `TCP src=${s?.sourcePort ?? 0}, dst=${s?.destinationPort ?? 0}, `
        + `seq=${s?.sequenceNumber ?? 0}, ack=${s?.acknowledgementNumber ?? 0}, `
        + `win=${s?.windowSize ?? 0}${noms ? ' ' + noms : ''}`;
    }
    if (proto === 17) {
      const u = t as { sourcePort?: number; destinationPort?: number };
      return `UDP src=${u?.sourcePort ?? 0}, dst=${u?.destinationPort ?? 0}`;
    }
    if (proto === 1) {
      const i = t as { icmpType?: string; code?: number };
      const num = i?.icmpType === 'echo-reply' ? 0
        : i?.icmpType === 'echo-request' ? 8
        : i?.icmpType === 'destination-unreachable' ? 3
        : i?.icmpType === 'redirect' ? 5
        : i?.icmpType === 'time-exceeded' ? 11 : 255;
      return `ICMP type=${num}, code=${i?.code ?? 0}`;
    }
    return null;
  }

  emitIcmpError(type: string, code: number, offendingDst: string, routerIp: string, replyTo: string): void {
    if (type === 'destination-unreachable') {
      const quoi = code === 1 ? 'host unreachable'
        : code === 0 ? 'net unreachable'
        : code === 13 ? 'administratively prohibited'
        : code === 4 ? 'frag. needed and DF set'
        : 'unreachable';
      this.emit('ip.icmp', `ICMP: dst (${offendingDst}) ${quoi}, src ${routerIp}`);
      return;
    }
    if (type === 'time-exceeded') {
      this.emit('ip.icmp', `ICMP: time exceeded (time to live) sent to ${replyTo}`);
    }
  }

  emitLine(category: DebugCategory, line: string): void {
    this.emit(category, line);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (!this.broadcast.beginAttach(bus, deviceId)) return;
    const mine = (p: { deviceId?: string }) => p.deviceId === undefined || p.deviceId === deviceId;
    this.broadcast.track(bus.subscribe('ospf.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.adj',
        `OSPF: ${p.iface} Nbr ${p.neighborId} state ${p.oldState} -> ${p.newState}, `
        + `event ${p.event}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.interface.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.events', `OSPF: Interface ${p.iface} state change from ${p.oldState} to ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.spf.run', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.ospf.spf', `OSPF: Running ${p.kind} SPF (run ${p.runIndex}), ${p.routesCount} routes, runtime ${p.runtimeMs}ms`);
    }));
    this.broadcast.track(bus.subscribe('ospf.lsa.installed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { areaId?: string; lsa?: { lsType?: number; linkStateId?: string; advertisingRouter?: string; sequenceNumber?: number } };
      const h = p.lsa ?? {};
      this.emit('ip.ospf.lsa-generation',
        `OSPF: Generate LSA type ${h.lsType ?? '?'}, LSID ${h.linkStateId ?? '?'}, adv rtr ${h.advertisingRouter ?? '?'}, area ${p.areaId ?? '?'}, seq 0x${(h.sequenceNumber ?? 0).toString(16).toUpperCase()}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.hello.mismatch', (e) => {
      if (!mine(e.payload)) return;
      for (const ligne of ospfHelloMismatchLines(e.payload)) {
        this.emit('ip.ospf.hello', ligne);
      }
    }));
    this.broadcast.track(bus.subscribe('ospf.hello.send-requested', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { iface?: string; areaId?: string; srcIp?: string };
      this.emit('ip.ospf.hello',
        `OSPF: Send hello to 224.0.0.5 area ${p.areaId ?? '0'} on ${p.iface ?? '?'}`
        + `${p.srcIp ? ` from ${p.srcIp}` : ''}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { srcIp?: string; iface?: string; packet?: { packetType?: number } };
      const t = p.packet?.packetType;
      this.emit('ip.ospf.packet',
        `OSPF: rcv. v:2 t:${t ?? 0} (${ospfTypeName(t)}) `
        + `from ${p.srcIp ?? '?'} on ${p.iface ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('ospf.packet.outgoing', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { destIp?: string; iface?: string; packet?: { packetType?: number } };
      const t = p.packet?.packetType;
      this.emit('ip.ospf.packet',
        `OSPF: snd. v:2 t:${t ?? 0} (${ospfTypeName(t)}) `
        + `to ${p.destIp ?? '?'} on ${p.iface ?? '?'}`);
    }));

    // Neighbour discovery, multicast, VXLAN and the DHCP client. These used
    // to be raised by the logging subsystem as `%CDP-7-DEBUGGING: …` — a
    // shape IOS never prints, invented from the severity name. Real debug
    // output carries the subsystem's own prefix and no severity at all.
    this.broadcast.track(bus.subscribe('cdp.neighbor.refreshed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { localPort?: string; remoteHost?: string };
      this.emit('cdp.packets',
        `CDP-PA: Packet received from ${p.remoteHost ?? '?'} on interface ${p.localPort ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('lldp.neighbor.refreshed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { localPort?: string; remoteSystem?: string };
      this.emit('lldp.packets',
        `LLDP: Received packet from ${p.remoteSystem ?? '?'} on ${p.localPort ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('pim.mroute.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { group?: string; source?: string; iif?: string };
      this.emit('ip.pim',
        `PIM(0): Update (${p.source ?? '*'}, ${p.group ?? '*'}), incoming interface ${p.iif ?? 'Null'}`);
    }));
    this.broadcast.track(bus.subscribe('vxlan.mac.learned', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { vni?: number; mac?: string; vtepIp?: string };
      this.emit('vxlan',
        `NVE: Learned ${p.mac ?? '?'} in VNI ${p.vni ?? 0} from peer ${p.vtepIp ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('dhcp.client.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { iface?: string; oldState?: string; newState?: string };
      this.emit('ip.dhcp.server',
        `DHCP: ${p.iface ?? '?'} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
    }));

    const decodeIp = (frame: unknown): { src: string; dst: string; proto: number; len: number; icmpType?: string; transport?: unknown } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; protocol?: number; totalLength?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string }; payload?: { type?: string; icmpType?: string; data?: { length?: number } } } };
      if (f?.etherType !== 0x0800 || f.payload?.type !== 'ipv4') return null;
      const ip = f.payload;
      return {
        src: ip.sourceIP?.toString?.() ?? '?',
        dst: ip.destinationIP?.toString?.() ?? '?',
        proto: ip.protocol ?? 0,
        len: ip.totalLength ?? 0,
        icmpType: ip.payload?.type === 'icmp' ? ip.payload.icmpType : undefined,
        transport: ip.payload,
      };
    };
    const decodeArp = (frame: unknown): { op: 'request' | 'reply'; senderIp: string; senderMac: string; targetIp: string; targetMac: string } | null => {
      const f = frame as { etherType?: number; payload?: { type?: string; operation?: 'request' | 'reply'; senderIP?: { toString(): string }; senderMAC?: { toString(): string }; targetIP?: { toString(): string }; targetMAC?: { toString(): string } } };
      if (f?.etherType !== 0x0806 || f.payload?.type !== 'arp') return null;
      const a = f.payload;
      return {
        op: a.operation === 'reply' ? 'reply' : 'request',
        senderIp: a.senderIP?.toString?.() ?? '?',
        senderMac: a.senderMAC?.toString?.() ?? '?',
        targetIp: a.targetIP?.toString?.() ?? '?',
        targetMac: a.targetMAC?.toString?.() ?? '?',
      };
    };
    const onFrame = (frame: unknown, dir: 'rcvd' | 'sent', iface: string) => {
      const arp = decodeArp(frame);
      if (arp) {
        const op = arp.op === 'reply' ? 'rep' : 'req';
        const senderMac = toCiscoMac(arp.senderMac);
        const targetMac = arp.op === 'request' ? '0000.0000.0000' : toCiscoMac(arp.targetMac);
        this.emit('ip.arp', `IP ARP: ${dir} ${op} src ${arp.senderIp} ${senderMac}, dst ${arp.targetIp} ${targetMac} ${iface}`);
        return;
      }
      // IPv6 is a separate protocol with a separate flag. `debug ip
      // packet` must not see it, and `debug ipv6 packet` must not see
      // IPv4 — the etherType decides, nothing else.
      const f6 = frame as { etherType?: number; payload?: { type?: string; nextHeader?: number; payloadLength?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string } } };
      if (f6?.etherType === 0x86dd && f6.payload?.type === 'ipv6') {
        const v6 = f6.payload;
        this.emit('ipv6.packet',
          `IPV6: s=${v6.sourceIP?.toString?.() ?? '?'} (${iface}), d=${v6.destinationIP?.toString?.() ?? '?'}, len ${v6.payloadLength ?? 0}, ${dir} (nxt ${v6.nextHeader ?? 0})`);
        this.tracerIcmpv6(v6, dir, iface);
        return;
      }
      const ip = decodeIp(frame);
      if (!ip) return;
      const faits = RouterDebugService.faitsDe(ip);
      const verbe = dir === 'sent' ? 'sending' : 'rcvd 3';
      const entree = dir === 'sent' ? 'local' : iface;
      this.emit('ip.packet',
        `IP: s=${ip.src} (${entree}), d=${ip.dst} (${iface}), len ${ip.len}, ${verbe}`, faits);
      const detail = RouterDebugService.ligneTransport(ip.proto, ip.transport);
      if (detail && this.flags.get('ip.packet')?.detail) this.emit('ip.packet', detail, faits);
      if (ip.proto === 6) this.tracerTcp(ip, dir, faits);
      if (ip.proto === 17 && dir === 'rcvd') {
        const u = ip.transport as { sourcePort?: number; destinationPort?: number; length?: number } | undefined;
        if (u) {
          this.emit('ip.udp',
            `UDP: src=${ip.src}(${u.sourcePort ?? 0}), dst=${ip.dst}(${u.destinationPort ?? 0}), `
            + `length=${u.length ?? 0}`, faits);
        }
      }
      if (ip.proto === 1) {
        if (ip.icmpType === 'echo-request') {
          this.emit('ip.icmp', `ICMP: echo received, src ${ip.src}, dst ${ip.dst}`, faits);
        } else if (ip.icmpType === 'echo-reply') {
          this.emit('ip.icmp', `ICMP: echo reply sent, src ${ip.src}, dst ${ip.dst}`, faits);
        } else {
          this.emit('ip.icmp', `ICMP: ${ip.icmpType ?? 'message'} ${dir}, src ${ip.src}, dst ${ip.dst}`, faits);
        }
      }
    };
    this.broadcast.track(bus.subscribe('port.link.up', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { portName?: string };
      this.emit('interface', `${p.portName ?? '?'} came back up`);
      this.emit('link', `LINK: Interface ${p.portName ?? '?'}, changed state to up`);
    }));
    this.broadcast.track(bus.subscribe('port.link.down', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { portName?: string };
      this.emit('interface', `${p.portName ?? '?'} went down`);
      this.emit('interface', `${p.portName ?? '?'} keepalive timer expired`);
      this.emit('link', `LINK: Interface ${p.portName ?? '?'}, changed state to down`);
    }));
    // `ip.sla.trace`/`track` étaient déclarées comme catégories et
    // émises par personne : `debug ip sla trace` retombait sur le
    // fourre-tout `debug ip` et imprimait « IP packet debugging is on ».
    this.broadcast.track(bus.subscribe('ipsla.probe.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      const rtt = p.rttMs === null ? '-' : `${Math.round(p.rttMs)} ms`;
      this.emit('ip.sla.trace',
        `IP SLA(${p.operationId}) Scheduler: probe completed, `
        + `type ${p.type}, target ${p.target ?? '-'}, RTT ${rtt}, return code ${p.returnCode}`);
      if (p.returnCode !== 'ok' && p.returnCode !== 'overThreshold') {
        this.emit('ip.sla.error',
          `IP SLA(${p.operationId}) ${p.returnCode}${p.diagText ? `: ${p.diagText}` : ''}`);
      }
    }));
    this.broadcast.track(bus.subscribe('ipsla.operation.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.sla.trace',
        `IP SLA(${p.operationId}) Scheduler: entry ${p.oldState} -> ${p.newState} (${p.reason})`);
    }));
    this.broadcast.track(bus.subscribe('track.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('track',
        `Track ${p.objectId} ${p.description} ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('rip.update.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.rip',
        `RIP: sending v2 update to ${p.destIp} via ${p.iface}`
        + `${p.triggered ? ' (triggered)' : ''}`);
      this.emit('ip.rip', `RIP: build update entries, ${p.routeCount} routes`);
    }));
    this.broadcast.track(bus.subscribe('rip.update.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.rip',
        `RIP: received v2 update from ${p.fromIp} on ${p.iface}, ${p.routeCount} entries`);
    }));
    this.broadcast.track(bus.subscribe('rip.route.added', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.rip',
        `RIP: ${p.network}/${maskToCidr(p.mask)} via ${p.nextHop} in ${p.metric} hops`);
    }));
    this.broadcast.track(bus.subscribe('rip.route.timed-out', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.rip', `RIP: ${p.network}/${maskToCidr(p.mask)} timed out, marked unreachable`);
    }));

    this.broadcast.track(bus.subscribe('hsrp.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('standby',
        `HSRP: ${shortIface(p.iface)} Grp ${p.group} State ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('hsrp.active.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('standby', `HSRP: ${shortIface(p.iface)} Grp ${p.group} Active router is `
        + `${p.activeIp ?? 'unknown'}, priority ${p.activePriority}`);
    }));

    this.broadcast.track(bus.subscribe('bgp.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ip.bgp', `BGP: ${p.neighborIp} went from ${p.oldState} to ${p.newState}`);
    }));

    this.broadcast.track(bus.subscribe('port.security.violation', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { portName?: string; mac?: { toString(): string }; action?: string };
      this.emit('port-security',
        `PSECURE: Violation on ${p.portName ?? '?'}, `
        + `MAC ${toCiscoMac(String(p.mac ?? ''))}, action ${p.action ?? 'shutdown'}`);
    }));
    this.broadcast.track(bus.subscribe('port.security.mac-aged', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { portName?: string; mac?: { toString(): string } };
      this.emit('port-security',
        `PSECURE: Aged out ${toCiscoMac(String(p.mac ?? ''))} on ${p.portName ?? '?'}`);
    }));

    this.broadcast.track(bus.subscribe('eigrp.neighbor.state-changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { neighborId?: string; iface?: string; oldState?: string; newState?: string };
      this.emit('ip.eigrp',
        `EIGRP: Neighbor ${p.neighborId ?? '?'} (${shortIface(p.iface ?? '?')}) is `
        + `${p.newState === 'up' ? 'up' : 'down'}: ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('eigrp.neighbor.k-value-mismatch', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { neighborId?: string; iface?: string };
      this.emit('ip.eigrp',
        `EIGRP: Neighbor ${p.neighborId ?? '?'} (${shortIface(p.iface ?? '?')}) K-value mismatch`);
    }));

    this.broadcast.track(bus.subscribe('router.ssh.session.opened', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { user?: string; peerIp?: string };
      this.emit('ip.ssh',
        `SSH: Session opened for user '${p.user ?? '?'}' from ${p.peerIp ?? '?'}`);
    }));
    this.broadcast.track(bus.subscribe('router.ssh.session.closed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { user?: string; peerIp?: string; reason?: string };
      this.emit('ip.ssh',
        `SSH: Session closed for user '${p.user ?? '?'}' from ${p.peerIp ?? '?'}`
        + `${p.reason ? ` (${p.reason})` : ''}`);
    }));

    this.broadcast.track(bus.subscribe('vrrp.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('vrrp',
        `VRRP: ${shortIface(p.iface)} Grp ${p.vrid} state ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('vrrp.master.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { iface?: string; vrid?: number; masterIp?: string | null };
      this.emit('vrrp',
        `VRRP: ${shortIface(p.iface ?? '?')} Grp ${p.vrid ?? 0} master is ${p.masterIp ?? 'unknown'}`);
    }));

    this.broadcast.track(bus.subscribe('glbp.avg.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('glbp',
        `GLBP: ${shortIface(p.iface)} Grp ${p.group} AVG state ${p.oldState} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('glbp.avf.state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { iface?: string; group?: number; forwarder?: number; newState?: string };
      this.emit('glbp',
        `GLBP: ${shortIface(p.iface ?? '?')} Grp ${p.group ?? 0} Fwd ${p.forwarder ?? 0} `
        + `state ${p.newState ?? '?'}`);
    }));

    this.broadcast.track(bus.subscribe('ntp.synced', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('ntp.events',
        `NTP: system clock synchronised to ${p.serverIp}, stratum ${p.newStratum}, `
        + `offset ${p.offsetMs} ms`);
    }));
    this.broadcast.track(bus.subscribe('ntp.unsynced', (e) => {
      if (!mine(e.payload)) return;
      this.emit('ntp.events', 'NTP: system clock has lost synchronisation');
    }));
    this.broadcast.track(bus.subscribe('ntp.packet.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { destIp?: string; mode?: string };
      this.emit('ntp.packets', `NTP: xmit packet to ${p.destIp ?? '?'}, mode ${p.mode ?? 'client'}`);
    }));
    this.broadcast.track(bus.subscribe('ntp.packet.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { srcIp?: string; mode?: string };
      this.emit('ntp.packets', `NTP: rcv packet from ${p.srcIp ?? '?'}, mode ${p.mode ?? 'server'}`);
    }));

    this.broadcast.track(bus.subscribe('radius.auth.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { username?: string; serverIp?: string };
      this.emit('radius',
        `RADIUS: Received Access-Accept for user ${p.username ?? '?'} from ${p.serverIp ?? '?'}`);
      this.emit('aaa.authentication',
        `AAA/AUTHEN: status = PASS for user '${p.username ?? '?'}'`);
    }));
    this.broadcast.track(bus.subscribe('radius.auth.rejected', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { username?: string; serverIp?: string };
      this.emit('radius',
        `RADIUS: Received Access-Reject for user ${p.username ?? '?'} from ${p.serverIp ?? '?'}`);
      this.emit('aaa.authentication',
        `AAA/AUTHEN: status = FAIL for user '${p.username ?? '?'}'`);
    }));
    this.broadcast.track(bus.subscribe('radius.server.dead', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { serverIp?: string };
      this.emit('radius', `RADIUS: Marking server ${p.serverIp ?? '?'} as DEAD`);
    }));
    this.broadcast.track(bus.subscribe('radius.accounting.record', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { username?: string; type?: string };
      this.emit('aaa.accounting',
        `AAA/ACCT: ${p.type ?? 'record'} for user '${p.username ?? '?'}'`);
    }));
    this.broadcast.track(bus.subscribe('tacacs.acct.completed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { username?: string };
      this.emit('tacacs', `TAC+: accounting complete for user ${p.username ?? '?'}`);
    }));

    this.broadcast.track(bus.subscribe('stp.role.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: ${p.port} role change ${p.oldRole} -> ${p.newRole}`);
    }));
    this.broadcast.track(bus.subscribe('stp.port-state.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: ${p.port} VLAN ${p.vlan} state change ${p.oldState ?? 'none'} -> ${p.newState}`);
    }));
    this.broadcast.track(bus.subscribe('stp.root.changed', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: New root ${p.newRootMac} (priority ${p.newRootPriority}), root port ${p.rootPort ?? 'none'}`);
    }));
    this.broadcast.track(bus.subscribe('stp.topology.change', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: Topology change (${p.origin})${p.port ? ` on ${p.port}` : ''}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu.sent', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.bpdu', `STP: Tx BPDU on ${p.port} Root Bridge ID ${p.rootMac} cost ${p.pathCost}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as unknown as { port?: string; senderMac?: string; rootMac?: string; pathCost?: number };
      this.emit('stp.bpdu',
        `STP: Rx BPDU on ${p.port ?? '?'} Bridge ID ${p.senderMac ?? '?'} `
        + `Root Bridge ID ${p.rootMac ?? '?'} cost ${p.pathCost ?? 0}`);
    }));
    this.broadcast.track(bus.subscribe('stp.bpdu-guard.violation', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('stp.events', `STP: BPDU guard violation on ${p.port} (sender ${p.senderMac})`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.learned', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('mac', `MAC: Learned ${p.mac} vlan ${p.vlan} on ${p.port} (dynamic)`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.moved', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('mac', `MAC: Moved ${p.mac} vlan ${p.vlan} from ${p.fromPort} to ${p.port}`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.aged', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload;
      this.emit('mac', `MAC: Aged out ${p.mac} vlan ${p.vlan} on ${p.port}`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.cleared', (e) => {
      if (!mine(e.payload)) return;
      this.emit('mac', `MAC: Cleared dynamic entries from address table`);
    }));
    this.broadcast.track(bus.subscribe('switch.mac.flushed', (e) => {
      if (!mine(e.payload)) return;
      this.emit('mac', `MAC: Flushed address table`);
    }));
    this.broadcast.track(bus.subscribe('port.frame.received', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { frame: unknown; portName?: string };
      onFrame(p.frame, 'rcvd', p.portName ?? '?');
    }));
    this.broadcast.track(bus.subscribe('port.frame.tx-requested', (e) => {
      if (!mine(e.payload)) return;
      const p = e.payload as { frame: unknown; portName?: string };
      onFrame(p.frame, 'sent', p.portName ?? '?');
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }

  static label(category: DebugCategory): string {
    switch (category) {
      case 'crypto.isakmp': return 'Crypto ISAKMP';
      case 'crypto.ipsec': return 'Crypto IPSEC';
      case 'ip.ospf.adj': return 'OSPF adjacency';
      case 'ip.ospf.events': return 'OSPF events';
      case 'ip.ospf.spf': return 'OSPF SPF';
      case 'ip.ospf.hello': return 'OSPF Hello';
      case 'ip.ospf.packet': return 'OSPF packet';
      case 'ip.ospf.lsa-generation': return 'OSPF LSA generation';
      case 'ip.rip': return 'RIP protocol';
      case 'ip.eigrp': return 'EIGRP';
      case 'ip.bgp': return 'BGP';
      case 'ip.routing': return 'IP routing';
      case 'ip.icmp': return 'ICMP packet';
      case 'ip.packet': return 'IP packet';
      case 'ip.tcp': return 'TCP special event';
      case 'ip.udp': return 'UDP packet';
      case 'ip.nat': return 'IP NAT';
      case 'ip.arp': return 'ARP packet';
      case 'interface': return 'Interface';
      case 'ip.dhcp.server': return 'DHCP server';
      case 'ip.ssh': return 'SSH';
      case 'ip.domain': return 'Domain Name System';
      case 'ip.nhrp': return 'NHRP';
      case 'standby': return 'HSRP';
      case 'vrrp': return 'VRRP';
      case 'glbp': return 'GLBP';
      case 'track': return 'TRACK';
      case 'ip.sla.trace': return 'IP SLA';
      case 'ip.sla.error': return 'IP SLA error';
      case 'aaa.authentication': return 'AAA Authentication';
      case 'aaa.authorization': return 'AAA Authorization';
      case 'aaa.accounting': return 'AAA Accounting';
      case 'radius': return 'RADIUS';
      case 'tacacs': return 'TACACS+';
      case 'ntp.events': return 'NTP events';
      case 'ntp.packets': return 'NTP packets';
      case 'lldp.packets': return 'LLDP packets';
      case 'cdp.packets': return 'CDP packets';
      case 'ip.pim': return 'PIM';
      case 'vxlan': return 'VXLAN';
      case 'port-security': return 'Port security';
      case 'ipv6.packet': return 'IPv6 packet';
      case 'ipv6.nd': return 'ICMP Neighbor Discovery';
      case 'ipv6.icmp': return 'ICMPv6';
      case 'mac': return 'MAC address table';
      case 'link': return 'Link state';
      case 'stp.events': return 'Spanning Tree event';
      case 'stp.bpdu': return 'Spanning Tree BPDU';
    }
  }

  /**
   * The debug category behind a syslog tag, for the severity-7 lines the
   * logging subsystem raises on its own (`LoggingConfig.setDebugGate`).
   * An unmapped tag has no `debug` verb to turn it on, so its lines stay
   * off — nothing may reach a console that never asked for it.
   */
  static categoryForSyslogTag(tag: string): DebugCategory | null {
    switch (tag) {
      case 'cdp': return 'cdp.packets';
      case 'lldp': return 'lldp.packets';
      case 'nat': return 'ip.nat';
      case 'arp': return 'ip.arp';
      case 'dhcp': return 'ip.dhcp.server';
      case 'domain': return 'ip.domain';
      case 'pim': return 'ip.pim';
      case 'vxlan': return 'vxlan';
      case 'port_security': return 'port-security';
      case 'ospf': return 'ip.ospf.events';
      default: return null;
    }
  }

  /** Is the `debug` behind this syslog tag currently on? */
  isEnabledForSyslogTag(tag: string): boolean {
    if (tag === 'ospf') {
      return [...this.flags.keys()].some(k => String(k).startsWith('ip.ospf.'));
    }
    const category = RouterDebugService.categoryForSyslogTag(tag);
    return category !== null && this.isEnabled(category);
  }

  private static readonly RUBRIQUES: ReadonlyArray<readonly [string, ReadonlyArray<DebugCategory>]> = [
    ['Generic IP', ['ip.packet', 'ip.icmp', 'ip.tcp', 'ip.udp', 'ip.arp', 'ip.routing', 'ip.nat']],
    ['IPv6', ['ipv6.packet', 'ipv6.nd', 'ipv6.icmp']],
    ['OSPF', ['ip.ospf.adj', 'ip.ospf.events', 'ip.ospf.spf', 'ip.ospf.hello',
      'ip.ospf.packet', 'ip.ospf.lsa-generation']],
    ['RIP', ['ip.rip']],
    ['EIGRP', ['ip.eigrp']],
    ['BGP', ['ip.bgp']],
    ['PIM', ['ip.pim']],
    ['NHRP', ['ip.nhrp']],
    ['DHCP', ['ip.dhcp.server']],
    ['SSH', ['ip.ssh']],
    ['Domain Name System', ['ip.domain']],
    ['First-hop redundancy', ['standby', 'vrrp', 'glbp']],
    ['IP SLA', ['ip.sla.trace', 'ip.sla.error', 'track']],
    ['AAA', ['aaa.authentication', 'aaa.authorization', 'aaa.accounting', 'radius', 'tacacs']],
    ['NTP', ['ntp.events', 'ntp.packets']],
    ['Neighbour discovery', ['cdp.packets', 'lldp.packets']],
    ['Crypto Subsystem', ['crypto.isakmp', 'crypto.ipsec']],
    ['Spanning Tree', ['stp.events', 'stp.bpdu']],
    ['Switching', ['mac', 'link']],
    ['Interface', ['interface', 'port-security']],
    ['VXLAN', ['vxlan']],
  ];

  private static rubrique(category: DebugCategory): { nom: string; rang: number; ordre: number } {
    for (let i = 0; i < RouterDebugService.RUBRIQUES.length; i++) {
      const [nom, membres] = RouterDebugService.RUBRIQUES[i];
      const ordre = membres.indexOf(category);
      if (ordre >= 0) return { nom, rang: i, ordre };
    }
    return { nom: 'Other', rang: RouterDebugService.RUBRIQUES.length, ordre: 0 };
  }

  formatConditions(): string {
    if (this.conditions.length === 0) return 'Condition 1 is not set';
    return this.conditions
      .map((c) => `Condition ${c.id}: ${c.kind} ${c.value} (0 flags triggered)`)
      .join('\n');
  }

  format(): string {
    if (this.flags.size === 0) return 'No debug flags are enabled';
    const rangees = [...this.flags.values()]
      .map((f) => ({ f, r: RouterDebugService.rubrique(f.category) }))
      .sort((a, b) => a.r.rang - b.r.rang || a.r.ordre - b.r.ordre);
    const out: string[] = [];
    let rubriqueCourante: string | null = null;
    for (const { f, r } of rangees) {
      if (r.nom !== rubriqueCourante) {
        out.push(`${r.nom}:`);
        rubriqueCourante = r.nom;
      }
      const custom = this.categoryRenderers.get(f.category);
      const ligne = custom ? custom() : RouterDebugService.flagLabel(f);
      for (const l of ligne.split('\n')) out.push(`  ${l}`);
    }
    return out.join('\n');
  }
}
