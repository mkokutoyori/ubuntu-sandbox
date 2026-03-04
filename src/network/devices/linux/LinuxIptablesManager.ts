/**
 * LinuxIptablesManager — iptables (netfilter) state manager.
 *
 * THE single source of truth for all packet filtering.
 * UFW is a frontend that translates its rules into iptables rules here.
 *
 * Faithfully reproduces real Linux iptables command behavior:
 * - 4 tables: filter, nat, mangle, raw
 * - Built-in chains with policies (ACCEPT/DROP)
 * - User-defined chains with reference counting
 * - Full rule matching: protocol, src/dst IP/CIDR, interfaces, ports, negation
 * - Match extensions: state, conntrack, multiport, comment, limit, mac, iprange
 * - Targets: ACCEPT, DROP, REJECT, LOG, MASQUERADE, DNAT, SNAT, REDIRECT, RETURN
 * - iptables-save / iptables-restore
 * - Real packet filtering with counter updates
 */

import type { VirtualFileSystem } from './VirtualFileSystem';

// ─── Packet filtering types (shared with UFW) ───────────────────────

export type FirewallVerdict = 'accept' | 'drop' | 'reject';

export interface PacketInfo {
  direction: 'in' | 'out' | 'forward';
  protocol: number;         // 1=ICMP, 6=TCP, 17=UDP
  srcIP: string;
  dstIP: string;
  srcPort: number;          // 0 for ICMP
  dstPort: number;          // 0 for ICMP
  iface: string;            // interface name (e.g. 'eth0') — inbound iface
  outIface?: string;        // outbound interface (only for FORWARD packets)
  macAddress?: string;      // source MAC address (for -m mac --mac-source)
  isV6?: boolean;           // true for IPv6 packets
}

// ─── Internal types ──────────────────────────────────────────────────

type TableName = 'filter' | 'nat' | 'mangle' | 'raw';
type BuiltinPolicy = 'ACCEPT' | 'DROP';

interface MatchExtension {
  module: string;               // e.g. 'state', 'conntrack', 'multiport', 'comment', 'limit', 'mac', 'iprange'
  options: Map<string, string>; // e.g. '--state' => 'ESTABLISHED,RELATED'
}

interface TargetOptions {
  [key: string]: string;
}

interface IptablesRule {
  protocol: string;       // 'tcp', 'udp', 'icmp', 'all', ''
  source: string;         // '' or IP/CIDR
  destination: string;    // '' or IP/CIDR
  inInterface: string;    // '' or 'eth0'
  outInterface: string;   // '' or 'eth0'
  sport: string;          // '' or '1024' or '1024:65535'
  dport: string;          // '' or '22' or '6000:6007'
  target: string;         // 'ACCEPT', 'DROP', 'REJECT', 'LOG', chain name, etc.
  targetOptions: TargetOptions;
  matches: MatchExtension[];
  negSource: boolean;
  negDestination: boolean;
  negProtocol: boolean;
  negInInterface: boolean;
  negOutInterface: boolean;
  pkts: number;
  bytes: number;
}

interface IptablesChain {
  name: string;
  policy: BuiltinPolicy | null; // null for user-defined chains
  rules: IptablesRule[];
  pkts: number;
  bytes: number;
}

interface IptablesTable {
  name: TableName;
  chains: Map<string, IptablesChain>;
}

// ─── Table definitions ───────────────────────────────────────────────

const TABLE_BUILTIN_CHAINS: Record<TableName, string[]> = {
  filter: ['INPUT', 'FORWARD', 'OUTPUT'],
  nat: ['PREROUTING', 'INPUT', 'OUTPUT', 'POSTROUTING'],
  mangle: ['PREROUTING', 'INPUT', 'FORWARD', 'OUTPUT', 'POSTROUTING'],
  raw: ['PREROUTING', 'OUTPUT'],
};

// ─── NAT result ────────────────────────────────────────────────────

export interface NatResult {
  action: 'MASQUERADE' | 'DNAT' | 'SNAT' | 'REDIRECT';
  address?: string;   // for DNAT: "ip:port", for SNAT: "ip", for REDIRECT: "port"
}

const VALID_TABLES = new Set<string>(['filter', 'nat', 'mangle', 'raw']);
const VALID_PROTOCOLS = new Set<string>(['tcp', 'udp', 'icmp', 'all']);
const VALID_BUILTIN_POLICIES = new Set<string>(['ACCEPT', 'DROP']);
const VALID_TARGETS = new Set<string>(['ACCEPT', 'DROP', 'REJECT', 'LOG', 'MASQUERADE', 'DNAT', 'SNAT', 'REDIRECT', 'RETURN']);

// ─── Manager ─────────────────────────────────────────────────────────

export class LinuxIptablesManager {
  private vfs: VirtualFileSystem | null = null;
  private tables: Map<TableName, IptablesTable> = new Map();
  // Rate limiting state for limit match extension: key = "srcIP:ruleKey" → timestamps
  private rateLimitHits: Map<string, number[]> = new Map();
  // Connection tracking: "proto:srcIP:srcPort:dstIP:dstPort" → timestamp
  // Used for state/conntrack match extensions
  private conntrack: Map<string, number> = new Map();
  private readonly CONNTRACK_TIMEOUT = 300_000; // 5 minutes

  constructor(vfs?: VirtualFileSystem) {
    if (vfs) this.vfs = vfs;
    this.initializeTables();
  }

  private initializeTables(): void {
    for (const [tableName, chainNames] of Object.entries(TABLE_BUILTIN_CHAINS)) {
      const table: IptablesTable = {
        name: tableName as TableName,
        chains: new Map(),
      };
      for (const chainName of chainNames) {
        table.chains.set(chainName, {
          name: chainName,
          policy: 'ACCEPT',
          rules: [],
          pkts: 0,
          bytes: 0,
        });
      }
      this.tables.set(tableName as TableName, table);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // REAL PACKET FILTERING — the single source of truth
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Evaluate the filter table against an actual packet.
   * This is THE only packet filtering engine in the system.
   * UFW translates its rules into iptables rules; this method evaluates them.
   *
   * Supports INPUT, OUTPUT, and FORWARD chains based on pkt.direction.
   */
  filterPacket(pkt: PacketInfo): FirewallVerdict {
    const filterTable = this.tables.get('filter')!;
    const chainName = pkt.direction === 'in' ? 'INPUT'
                    : pkt.direction === 'out' ? 'OUTPUT'
                    : 'FORWARD';
    const chain = filterTable.chains.get(chainName)!;
    const verdict = this.evaluateChain(filterTable, chain, pkt, 0);

    // Track established connections for accepted packets
    if (verdict === 'accept' && (pkt.direction === 'in' || pkt.direction === 'forward')) {
      this.trackConnection(pkt);
    }

    return verdict;
  }

  /**
   * Evaluate nat table for a packet (PREROUTING or POSTROUTING).
   * Returns DNAT/SNAT/MASQUERADE target info or null.
   */
  evaluateNat(pkt: PacketInfo, hook: 'PREROUTING' | 'POSTROUTING'): NatResult | null {
    const natTable = this.tables.get('nat');
    if (!natTable) return null;
    const chain = natTable.chains.get(hook);
    if (!chain) return null;

    for (const rule of chain.rules) {
      if (this.ruleMatchesPacket(rule, pkt)) {
        rule.pkts++;
        rule.bytes += 64;
        chain.pkts++;
        chain.bytes += 64;

        switch (rule.target) {
          case 'MASQUERADE':
            return { action: 'MASQUERADE' };
          case 'DNAT': {
            const toDest = rule.targetOptions['--to-destination'] || '';
            return { action: 'DNAT', address: toDest };
          }
          case 'SNAT': {
            const toSrc = rule.targetOptions['--to-source'] || '';
            return { action: 'SNAT', address: toSrc };
          }
          case 'REDIRECT': {
            const toPort = rule.targetOptions['--to-port'] || rule.targetOptions['--to-ports'] || '';
            return { action: 'REDIRECT', address: toPort };
          }
          default: continue;
        }
      }
    }
    return null;
  }

  // ─── Connection tracking ──────────────────────────────────────

  /** Track a connection for state/conntrack matching (ESTABLISHED,RELATED) */
  private trackConnection(pkt: PacketInfo): void {
    // Track the reply direction: so the reply (dst→src) is ESTABLISHED
    const replyKey = `${pkt.protocol}:${pkt.dstIP}:${pkt.dstPort}:${pkt.srcIP}:${pkt.srcPort}`;
    this.conntrack.set(replyKey, Date.now());
    // Also track original direction
    const origKey = `${pkt.protocol}:${pkt.srcIP}:${pkt.srcPort}:${pkt.dstIP}:${pkt.dstPort}`;
    this.conntrack.set(origKey, Date.now());
    // Periodically clean old entries (keep it simple — clean on every 50th insert)
    if (this.conntrack.size > 200) this.cleanConntrack();
  }

  /** Check if a packet matches an ESTABLISHED or RELATED connection */
  private isEstablished(pkt: PacketInfo): boolean {
    const key = `${pkt.protocol}:${pkt.srcIP}:${pkt.srcPort}:${pkt.dstIP}:${pkt.dstPort}`;
    const ts = this.conntrack.get(key);
    if (!ts) return false;
    if (Date.now() - ts > this.CONNTRACK_TIMEOUT) {
      this.conntrack.delete(key);
      return false;
    }
    return true;
  }

  private cleanConntrack(): void {
    const now = Date.now();
    for (const [key, ts] of this.conntrack) {
      if (now - ts > this.CONNTRACK_TIMEOUT) this.conntrack.delete(key);
    }
  }

  /**
   * Evaluate a chain against a packet.
   * Returns { verdict, terminated } where terminated=true means a rule explicitly
   * decided the packet's fate (ACCEPT/DROP/REJECT). terminated=false means the
   * chain was exhausted without a terminal decision (equivalent to RETURN).
   */
  private evaluateChain(table: IptablesTable, chain: IptablesChain, pkt: PacketInfo, depth: number): FirewallVerdict {
    if (depth > 20) return 'accept';

    const innerResult = this.evaluateChainInner(table, chain, pkt, depth);
    if (innerResult !== null) return innerResult;

    // No rule matched → apply chain policy (only built-in chains have policies)
    if (chain.policy === 'DROP') return 'drop';
    return 'accept';
  }

  /**
   * Inner chain evaluation. Returns null if the chain was exhausted (RETURN behavior),
   * or a FirewallVerdict if a terminal decision was made.
   */
  private evaluateChainInner(table: IptablesTable, chain: IptablesChain, pkt: PacketInfo, depth: number): FirewallVerdict | null {
    if (depth > 20) return 'accept';

    for (const rule of chain.rules) {
      if (this.ruleMatchesPacket(rule, pkt)) {
        // Update counters
        rule.pkts++;
        rule.bytes += 64;
        chain.pkts++;
        chain.bytes += 64;

        // If target is a user-defined chain, jump into it
        const targetChain = table.chains.get(rule.target);
        if (targetChain && targetChain.policy === null) {
          const result = this.evaluateChainInner(table, targetChain, pkt, depth + 1);
          // null = sub-chain fell through (RETURN) → continue in calling chain
          if (result === null) continue;
          return result;
        }

        switch (rule.target) {
          case 'ACCEPT': return 'accept';
          case 'DROP': return 'drop';
          case 'REJECT': return 'reject';
          case 'RETURN': return null; // return to calling chain
          case 'LOG': continue; // LOG doesn't terminate; continue to next rule
          default: continue;
        }
      }
    }

    // Chain exhausted without terminal decision
    return null;
  }

  private ruleMatchesPacket(rule: IptablesRule, pkt: PacketInfo): boolean {
    // Protocol check
    if (rule.protocol && rule.protocol !== 'all') {
      const protoNum = rule.protocol === 'tcp' ? 6 : rule.protocol === 'udp' ? 17 : rule.protocol === 'icmp' ? 1 : -1;
      const matches = pkt.protocol === protoNum;
      if (rule.negProtocol ? matches : !matches) return false;
    }

    // Source IP check
    if (rule.source) {
      const matches = this.ipMatchesSpec(pkt.srcIP, rule.source);
      if (rule.negSource ? matches : !matches) return false;
    }

    // Destination IP check
    if (rule.destination) {
      const matches = this.ipMatchesSpec(pkt.dstIP, rule.destination);
      if (rule.negDestination ? matches : !matches) return false;
    }

    // Input interface
    if (rule.inInterface) {
      const matches = pkt.iface === rule.inInterface;
      if (rule.negInInterface ? matches : !matches) return false;
    }

    // Output interface — for FORWARD packets, match against outIface
    if (rule.outInterface) {
      const outIf = pkt.outIface || pkt.iface;
      const matches = outIf === rule.outInterface;
      if (rule.negOutInterface ? matches : !matches) return false;
    }

    // Destination port
    if (rule.dport) {
      if (!this.portMatchesSpec(pkt.dstPort, rule.dport)) return false;
    }

    // Source port
    if (rule.sport) {
      if (!this.portMatchesSpec(pkt.srcPort, rule.sport)) return false;
    }

    // Match extensions
    for (const m of rule.matches) {
      if (m.module === 'multiport') {
        const dports = m.options.get('--dports');
        const sports = m.options.get('--sports');
        if (dports && !this.portMatchesSpec(pkt.dstPort, dports)) return false;
        if (sports && !this.portMatchesSpec(pkt.srcPort, sports)) return false;
      }
      // limit match: enforce rate limiting per source IP
      if (m.module === 'limit') {
        const limitStr = m.options.get('--limit') || '6/minute';
        const burstStr = m.options.get('--limit-burst') || '6';
        const burst = parseInt(burstStr) || 6;
        // Parse rate: "N/second", "N/minute", "N/hour"
        const rateMatch = limitStr.match(/^(\d+)\/(second|minute|hour)$/);
        const windowMs = rateMatch
          ? (rateMatch[2] === 'second' ? 1000 : rateMatch[2] === 'minute' ? 60000 : 3600000)
          : 60000;

        // Build key from src IP + rule port spec for per-source tracking
        const ruleKey = `${pkt.srcIP}:${rule.protocol}:${rule.dport}`;
        const now = Date.now();
        let hits = this.rateLimitHits.get(ruleKey);
        if (!hits) {
          hits = [];
          this.rateLimitHits.set(ruleKey, hits);
        }
        // Purge expired entries
        const cutoff = now - windowMs;
        while (hits.length > 0 && hits[0] < cutoff) hits.shift();
        if (hits.length >= burst) {
          return false; // Rate limit exceeded → rule doesn't match → fall through to next rule
        }
        hits.push(now);
      }
      // state/conntrack: evaluate connection tracking
      if (m.module === 'state' || m.module === 'conntrack') {
        const states = (m.options.get('--state') || m.options.get('--ctstate') || '').toUpperCase();
        if (states) {
          const stateList = states.split(',');
          const isEstab = this.isEstablished(pkt);
          // NEW: packet not in conntrack table
          // ESTABLISHED: packet matches an existing connection
          // RELATED: simplified — treat same as ESTABLISHED
          const matchesState =
            (stateList.includes('ESTABLISHED') && isEstab) ||
            (stateList.includes('RELATED') && isEstab) ||
            (stateList.includes('NEW') && !isEstab);
          if (!matchesState) return false;
        }
      }
      // mac match: check source MAC address
      if (m.module === 'mac') {
        const macSrc = m.options.get('--mac-source');
        if (macSrc && pkt.macAddress) {
          if (pkt.macAddress.toLowerCase() !== macSrc.toLowerCase()) return false;
        } else if (macSrc && !pkt.macAddress) {
          return false; // no MAC info → can't match
        }
      }
      // iprange match: check IP ranges
      if (m.module === 'iprange') {
        const srcRange = m.options.get('--src-range');
        const dstRange = m.options.get('--dst-range');
        if (srcRange && !this.ipInRange(pkt.srcIP, srcRange)) return false;
        if (dstRange && !this.ipInRange(pkt.dstIP, dstRange)) return false;
      }
      // comment match: no filtering effect, just stored
    }

    return true;
  }

  private ipMatchesSpec(ip: string, spec: string): boolean {
    if (!spec.includes('/')) return ip === spec;
    const [network, prefixStr] = spec.split('/');
    const prefix = parseInt(prefixStr);
    if (isNaN(prefix)) return false;
    const ipNum = this.ipToNumber(ip);
    const netNum = this.ipToNumber(network);
    if (ipNum === null || netNum === null) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) === (netNum & mask);
  }

  private ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const octets = parts.map(p => parseInt(p));
    if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return null;
    return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  }

  private portMatchesSpec(port: number, spec: string): boolean {
    if (spec.includes(':')) {
      const [s, e] = spec.split(':');
      return port >= parseInt(s) && port <= parseInt(e);
    }
    if (spec.includes(',')) {
      return spec.split(',').map(p => parseInt(p)).includes(port);
    }
    return port === parseInt(spec);
  }

  /** Check if an IP address is within a range like "192.168.1.10-192.168.1.50" */
  private ipInRange(ip: string, range: string): boolean {
    const parts = range.split('-');
    if (parts.length !== 2) return false;
    const ipNum = this.ipToNumber(ip);
    const startNum = this.ipToNumber(parts[0].trim());
    const endNum = this.ipToNumber(parts[1].trim());
    if (ipNum === null || startNum === null || endNum === null) return false;
    return ipNum >= startNum && ipNum <= endNum;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PROGRAMMATIC API — used by UFW to inject/remove iptables rules
  // ═══════════════════════════════════════════════════════════════════

  /** Get the filter table (used by UFW to manipulate chains) */
  getTable(name: TableName): IptablesTable | undefined {
    return this.tables.get(name);
  }

  /** Append a rule programmatically (used by UFW) */
  appendRule(tableName: TableName, chainName: string, rule: IptablesRule): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain) return false;
    chain.rules.push(rule);
    return true;
  }

  /** Insert a rule at a position (1-indexed) programmatically */
  insertRule(tableName: TableName, chainName: string, pos: number, rule: IptablesRule): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain) return false;
    const idx = Math.min(Math.max(pos - 1, 0), chain.rules.length);
    chain.rules.splice(idx, 0, rule);
    return true;
  }

  /** Flush all rules from a chain */
  flushChain(tableName: TableName, chainName: string): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain) return false;
    chain.rules = [];
    return true;
  }

  /** Set the policy of a built-in chain */
  setPolicy(tableName: TableName, chainName: string, policy: BuiltinPolicy): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    const chain = table.chains.get(chainName);
    if (!chain || chain.policy === null) return false;
    chain.policy = policy;
    return true;
  }

  /** Get the policy of a chain */
  getPolicy(tableName: TableName, chainName: string): string | null {
    const table = this.tables.get(tableName);
    if (!table) return null;
    const chain = table.chains.get(chainName);
    return chain?.policy ?? null;
  }

  /** Create a new user-defined chain */
  createChain(tableName: TableName, chainName: string): boolean {
    const table = this.tables.get(tableName);
    if (!table) return false;
    if (table.chains.has(chainName)) return false;
    table.chains.set(chainName, { name: chainName, policy: null, rules: [], pkts: 0, bytes: 0 });
    return true;
  }

  /** Delete a user-defined chain */
  deleteChain(tableName: TableName, chainName: string): string | null {
    const table = this.tables.get(tableName);
    if (!table) return 'table not found';
    const chain = table.chains.get(chainName);
    if (!chain) return 'No chain/target/match by that name';
    if (chain.policy !== null) return `Can't delete built-in chain`;
    if (chain.rules.length > 0) return 'Directory not empty';
    table.chains.delete(chainName);
    return null;
  }

  /** Create a default empty rule (helper for UFW) */
  static createRule(overrides?: Partial<IptablesRule>): IptablesRule {
    return {
      protocol: '', source: '', destination: '',
      inInterface: '', outInterface: '',
      sport: '', dport: '',
      target: '', targetOptions: {}, matches: [],
      negSource: false, negDestination: false, negProtocol: false,
      negInInterface: false, negOutInterface: false,
      pkts: 0, bytes: 0,
      ...overrides,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMMAND-LINE INTERFACE — iptables [-t table] <command>
  // ═══════════════════════════════════════════════════════════════════

  execute(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: this.showUsage(), exitCode: 2 };

    // Parse -t table
    let tableName: TableName = 'filter';
    const a = [...args];
    const tIdx = a.indexOf('-t');
    if (tIdx !== -1 && tIdx + 1 < a.length) {
      const t = a[tIdx + 1];
      if (!VALID_TABLES.has(t)) {
        return { output: `iptables v1.8.7 (nf_tables): can't initialize iptables table \`${t}': Table does not exist`, exitCode: 1 };
      }
      tableName = t as TableName;
      a.splice(tIdx, 2);
    }

    const table = this.tables.get(tableName)!;
    if (a.length === 0) return { output: this.showUsage(), exitCode: 2 };

    const cmd = a[0];
    const rest = a.slice(1);

    switch (cmd) {
      case '-L': case '--list':       return this.cmdList(table, rest);
      case '-S': case '--list-rules': return this.cmdListRules(table, rest);
      case '-F': case '--flush':      return this.cmdFlush(table, rest);
      case '-P': case '--policy':     return this.cmdPolicy(table, rest);
      case '-A': case '--append':     return this.cmdAppend(table, rest);
      case '-D': case '--delete':     return this.cmdDelete(table, rest);
      case '-I': case '--insert':     return this.cmdInsert(table, rest);
      case '-R': case '--replace':    return this.cmdReplace(table, rest);
      case '-C': case '--check':      return this.cmdCheck(table, rest);
      case '-N': case '--new-chain':  return this.cmdNewChain(table, rest);
      case '-X': case '--delete-chain': return this.cmdDeleteChain(table, rest);
      case '-E': case '--rename-chain': return this.cmdRenameChain(table, rest);
      case '-Z': case '--zero':       return this.cmdZero(table, rest);
      default:
        return { output: `iptables v1.8.7 (nf_tables): unknown option "${cmd}"`, exitCode: 2 };
    }
  }

  // ─── -L ────────────────────────────────────────────────────────

  private cmdList(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    let chainName = '';
    let numeric = false, verbose = false, lineNumbers = false;

    for (const arg of args) {
      switch (arg) {
        case '-n': case '--numeric': numeric = true; break;
        case '-v': case '--verbose': verbose = true; break;
        case '--line-numbers': lineNumbers = true; break;
        default: if (!arg.startsWith('-')) chainName = arg; break;
      }
    }

    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
      return { output: this.fmtChainList(chain, table, verbose, numeric, lineNumbers), exitCode: 0 };
    }

    const parts: string[] = [];
    for (const chain of table.chains.values()) {
      if (parts.length > 0) parts.push('');
      parts.push(this.fmtChainList(chain, table, verbose, numeric, lineNumbers));
    }
    return { output: parts.join('\n'), exitCode: 0 };
  }

  private fmtChainList(chain: IptablesChain, table: IptablesTable, verbose: boolean, numeric: boolean, lineNumbers: boolean): string {
    const lines: string[] = [];
    if (chain.policy !== null) {
      lines.push(`Chain ${chain.name} (policy ${chain.policy})`);
    } else {
      lines.push(`Chain ${chain.name} (${this.countRefs(chain.name, table)} references)`);
    }

    const numCol = lineNumbers ? 'num   ' : '';
    if (verbose) {
      lines.push(`${numCol} pkts bytes target     prot opt in     out     source               destination`);
    } else {
      lines.push(`${numCol}target     prot opt source               destination`);
    }

    for (let i = 0; i < chain.rules.length; i++) {
      const r = chain.rules[i];
      const num = lineNumbers ? `${i + 1}     `.slice(0, 6) : '';
      const target = r.target.padEnd(10);
      const prot = ((r.negProtocol ? '!' : '') + (r.protocol || 'all')).padEnd(4);
      const opt = '--  ';
      const src = this.fmtAddr(r.source, r.negSource, numeric);
      const dst = this.fmtAddr(r.destination, r.negDestination, numeric);
      const extra = this.fmtRuleExtras(r);

      if (verbose) {
        const pkts = String(r.pkts).padStart(5);
        const bytes = String(r.bytes).padStart(5);
        const inIf = ((r.negInInterface ? '!' : '') + (r.inInterface || '*')).padEnd(6);
        const outIf = ((r.negOutInterface ? '!' : '') + (r.outInterface || '*')).padEnd(6);
        lines.push(`${num}${pkts} ${bytes} ${target} ${prot} ${opt}${inIf} ${outIf} ${src.padEnd(20)} ${dst}${extra}`);
      } else {
        lines.push(`${num}${target} ${prot} ${opt}${src.padEnd(20)} ${dst}${extra}`);
      }
    }
    return lines.join('\n');
  }

  private fmtAddr(addr: string, neg: boolean, numeric: boolean): string {
    const n = neg ? '!' : '';
    if (!addr) return numeric ? `${n}0.0.0.0/0` : `${n}anywhere`;
    return `${n}${addr}`;
  }

  private fmtRuleExtras(r: IptablesRule): string {
    const parts: string[] = [];
    if (r.dport) parts.push(`${r.protocol} dpt:${r.dport}`);
    if (r.sport) parts.push(`${r.protocol} spt:${r.sport}`);
    for (const m of r.matches) {
      for (const [opt, val] of m.options) parts.push(`${opt.replace('--', '')}:${val}`);
    }
    for (const [opt, val] of Object.entries(r.targetOptions)) parts.push(`${opt.replace('--', '')} ${val}`);
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  private countRefs(name: string, table: IptablesTable): number {
    let n = 0;
    for (const c of table.chains.values()) for (const r of c.rules) if (r.target === name) n++;
    return n;
  }

  // ─── -S ────────────────────────────────────────────────────────

  private cmdListRules(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const chainName = args.find(a => !a.startsWith('-'));
    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
      return { output: this.fmtChainRules(chain), exitCode: 0 };
    }
    const parts: string[] = [];
    for (const chain of table.chains.values()) parts.push(this.fmtChainRules(chain));
    return { output: parts.join('\n'), exitCode: 0 };
  }

  private fmtChainRules(chain: IptablesChain): string {
    const lines: string[] = [];
    if (chain.policy !== null) lines.push(`-P ${chain.name} ${chain.policy}`);
    for (const rule of chain.rules) lines.push(this.fmtRuleCmd('A', chain.name, rule));
    return lines.join('\n');
  }

  fmtRuleCmd(action: string, chainName: string, rule: IptablesRule): string {
    const p: string[] = [`-${action} ${chainName}`];
    if (rule.source)       { if (rule.negSource) p.push('!'); p.push(`-s ${rule.source}`); }
    if (rule.destination)  { if (rule.negDestination) p.push('!'); p.push(`-d ${rule.destination}`); }
    if (rule.inInterface)  { if (rule.negInInterface) p.push('!'); p.push(`-i ${rule.inInterface}`); }
    if (rule.outInterface) { if (rule.negOutInterface) p.push('!'); p.push(`-o ${rule.outInterface}`); }
    if (rule.protocol && rule.protocol !== 'all') { if (rule.negProtocol) p.push('!'); p.push(`-p ${rule.protocol}`); }
    if (rule.sport) p.push(`--sport ${rule.sport}`);
    if (rule.dport) p.push(`--dport ${rule.dport}`);
    for (const m of rule.matches) {
      p.push(`-m ${m.module}`);
      for (const [opt, val] of m.options) p.push(`${opt} ${this.quote(val)}`);
    }
    if (rule.target) {
      p.push(`-j ${rule.target}`);
      for (const [opt, val] of Object.entries(rule.targetOptions)) p.push(`${opt} ${this.quote(val)}`);
    }
    return p.join(' ');
  }

  private quote(v: string): string { return v.includes(' ') ? `"${v}"` : v; }

  // ─── -F ────────────────────────────────────────────────────────

  private cmdFlush(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const cn = args.find(a => !a.startsWith('-'));
    if (cn) {
      const ch = table.chains.get(cn);
      if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
      ch.rules = [];
    } else {
      for (const ch of table.chains.values()) ch.rules = [];
    }
    return { output: '', exitCode: 0 };
  }

  // ─── -P ────────────────────────────────────────────────────────

  private cmdPolicy(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -P requires a chain and a policy', exitCode: 2 };
    const [cn, pol] = args;
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    if (ch.policy === null) return { output: `iptables: Can't set policy on user-defined chain \`${cn}'`, exitCode: 1 };
    if (!VALID_BUILTIN_POLICIES.has(pol)) return { output: 'iptables v1.8.7 (nf_tables): Bad policy name. Try ACCEPT or DROP.', exitCode: 2 };
    ch.policy = pol as BuiltinPolicy;
    return { output: '', exitCode: 0 };
  }

  // ─── -A ────────────────────────────────────────────────────────

  private cmdAppend(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: 'iptables v1.8.7 (nf_tables): -A requires a chain name', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    const r = this.parseRule(args.slice(1));
    if (typeof r === 'string') return { output: r, exitCode: 1 };
    // Validate target exists if it's a chain jump
    if (r.target && !VALID_TARGETS.has(r.target) && !table.chains.has(r.target)) {
      return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    }
    ch.rules.push(r);
    return { output: '', exitCode: 0 };
  }

  // ─── -D ────────────────────────────────────────────────────────

  private cmdDelete(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -D requires a chain and rule specification or number', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };

    // Delete by number
    if (args.length === 2 && /^\d+$/.test(args[1])) {
      const num = parseInt(args[1]);
      if (num < 1 || num > ch.rules.length) return { output: 'iptables: Index of deletion too big.', exitCode: 1 };
      ch.rules.splice(num - 1, 1);
      return { output: '', exitCode: 0 };
    }

    // Delete by specification
    const spec = this.parseRule(args.slice(1));
    if (typeof spec === 'string') return { output: spec, exitCode: 1 };
    const idx = ch.rules.findIndex(r => this.rulesEqual(r, spec));
    if (idx === -1) return { output: 'iptables: Bad rule (does a matching rule exist in that chain?).', exitCode: 1 };
    ch.rules.splice(idx, 1);
    return { output: '', exitCode: 0 };
  }

  // ─── -I ────────────────────────────────────────────────────────

  private cmdInsert(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: 'iptables v1.8.7 (nf_tables): -I requires a chain name', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };

    let pos = 1;
    let ruleArgs: string[];
    if (args.length > 1 && /^\d+$/.test(args[1])) {
      pos = parseInt(args[1]);
      ruleArgs = args.slice(2);
    } else {
      ruleArgs = args.slice(1);
    }

    const r = this.parseRule(ruleArgs);
    if (typeof r === 'string') return { output: r, exitCode: 1 };
    ch.rules.splice(Math.min(pos - 1, ch.rules.length), 0, r);
    return { output: '', exitCode: 0 };
  }

  // ─── -R ────────────────────────────────────────────────────────

  private cmdReplace(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 3) return { output: 'iptables v1.8.7 (nf_tables): -R requires a chain, rule number, and rule specification', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    const num = parseInt(args[1]);
    if (isNaN(num) || num < 1 || num > ch.rules.length) return { output: 'iptables: Index of replacement too big.', exitCode: 1 };
    const r = this.parseRule(args.slice(2));
    if (typeof r === 'string') return { output: r, exitCode: 1 };
    ch.rules[num - 1] = r;
    return { output: '', exitCode: 0 };
  }

  // ─── -C ────────────────────────────────────────────────────────

  private cmdCheck(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -C requires a chain and rule specification', exitCode: 2 };
    const cn = args[0];
    const ch = table.chains.get(cn);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    const spec = this.parseRule(args.slice(1));
    if (typeof spec === 'string') return { output: spec, exitCode: 1 };
    if (!ch.rules.some(r => this.rulesEqual(r, spec))) {
      return { output: 'iptables: Bad rule (does a matching rule exist in that chain?).', exitCode: 1 };
    }
    return { output: '', exitCode: 0 };
  }

  // ─── -N ────────────────────────────────────────────────────────

  private cmdNewChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) return { output: 'iptables v1.8.7 (nf_tables): -N requires a chain name', exitCode: 2 };
    if (table.chains.has(args[0])) return { output: 'iptables: Chain already exists.', exitCode: 1 };
    table.chains.set(args[0], { name: args[0], policy: null, rules: [], pkts: 0, bytes: 0 });
    return { output: '', exitCode: 0 };
  }

  // ─── -X ────────────────────────────────────────────────────────

  private cmdDeleteChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      const del: string[] = [];
      for (const [n, c] of table.chains) if (c.policy === null && c.rules.length === 0) del.push(n);
      for (const n of del) table.chains.delete(n);
      return { output: '', exitCode: 0 };
    }
    const err = this.deleteChain(table.name, args[0]);
    if (err) {
      if (err.includes('built-in')) return { output: `iptables: ${err}`, exitCode: 1 };
      return { output: `iptables: ${err}.`, exitCode: 1 };
    }
    return { output: '', exitCode: 0 };
  }

  // ─── -E ────────────────────────────────────────────────────────

  private cmdRenameChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) return { output: 'iptables v1.8.7 (nf_tables): -E requires old and new chain names', exitCode: 2 };
    const [oldN, newN] = args;
    const ch = table.chains.get(oldN);
    if (!ch) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    if (ch.policy !== null) return { output: "iptables: Can't rename built-in chain.", exitCode: 1 };
    if (table.chains.has(newN)) return { output: 'iptables: File exists.', exitCode: 1 };
    table.chains.delete(oldN);
    ch.name = newN;
    table.chains.set(newN, ch);
    for (const c of table.chains.values()) for (const r of c.rules) if (r.target === oldN) r.target = newN;
    return { output: '', exitCode: 0 };
  }

  // ─── -Z ────────────────────────────────────────────────────────

  private cmdZero(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const cn = args.find(a => !a.startsWith('-'));
    const chains = cn ? [table.chains.get(cn)].filter(Boolean) as IptablesChain[] : [...table.chains.values()];
    if (cn && !table.chains.has(cn)) return { output: 'iptables: No chain/target/match by that name.', exitCode: 1 };
    for (const ch of chains) {
      ch.pkts = 0; ch.bytes = 0;
      for (const r of ch.rules) { r.pkts = 0; r.bytes = 0; }
    }
    return { output: '', exitCode: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // iptables-save / iptables-restore
  // ═══════════════════════════════════════════════════════════════════

  executeSave(): string {
    const lines: string[] = ['# Generated by iptables-save'];
    for (const [tn, table] of this.tables) {
      const hasContent = [...table.chains.values()].some(c => c.rules.length > 0 || (c.policy !== null && c.policy !== 'ACCEPT') || c.policy === null);
      if (!hasContent && tn !== 'filter') continue;

      lines.push(`*${tn}`);
      for (const [, ch] of table.chains) {
        lines.push(`:${ch.name} ${ch.policy ?? '-'} [${ch.pkts}:${ch.bytes}]`);
      }
      for (const [, ch] of table.chains) {
        for (const r of ch.rules) lines.push(this.fmtRuleCmd('A', ch.name, r));
      }
      lines.push('COMMIT');
    }
    return lines.join('\n');
  }

  executeRestore(input: string): { output: string; exitCode: number } {
    const lines = input.split('\n');
    let curTable: IptablesTable | null = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('*')) {
        const tn = line.slice(1);
        if (!VALID_TABLES.has(tn)) return { output: `iptables-restore: line failed: ${line}`, exitCode: 1 };
        curTable = this.tables.get(tn as TableName)!;
        for (const ch of curTable.chains.values()) ch.rules = [];
        continue;
      }
      if (line === 'COMMIT') { curTable = null; continue; }
      if (!curTable) continue;

      if (line.startsWith(':')) {
        const m = line.match(/^:(\S+)\s+(\S+)\s+\[(\d+):(\d+)\]/);
        if (m) {
          let ch = curTable.chains.get(m[1]);
          if (!ch) { ch = { name: m[1], policy: null, rules: [], pkts: 0, bytes: 0 }; curTable.chains.set(m[1], ch); }
          if (m[2] !== '-') ch.policy = m[2] as BuiltinPolicy;
          ch.pkts = parseInt(m[3]); ch.bytes = parseInt(m[4]);
        }
        continue;
      }

      if (line.startsWith('-A ')) {
        const ruleArgs = this.tokenize(line.slice(3));
        const res = this.cmdAppend(curTable, ruleArgs);
        if (res.exitCode !== 0) return { output: `iptables-restore: line failed: ${line}`, exitCode: 1 };
      }
    }
    return { output: '', exitCode: 0 };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Rule parsing & validation
  // ═══════════════════════════════════════════════════════════════════

  parseRule(args: string[]): IptablesRule | string {
    const rule = LinuxIptablesManager.createRule();
    let i = 0;

    while (i < args.length) {
      const isNeg = args[i] === '!';
      if (isNeg) { i++; if (i >= args.length) break; }

      switch (args[i]) {
        case '-p': case '--protocol':
          i++;
          if (i >= args.length) return 'iptables: option "-p" requires an argument';
          if (isNeg) rule.negProtocol = true;
          rule.protocol = args[i];
          if (rule.protocol !== 'all' && !VALID_PROTOCOLS.has(rule.protocol)) {
            return `iptables v1.8.7 (nf_tables): unknown protocol "${rule.protocol}"`;
          }
          break;

        case '-s': case '--source':
          i++;
          if (i >= args.length) return 'iptables: option "-s" requires an argument';
          if (isNeg) rule.negSource = true;
          rule.source = args[i];
          if (!this.validateIPSpec(rule.source)) return `iptables: host/network \`${rule.source}' not found`;
          break;

        case '-d': case '--destination':
          i++;
          if (i >= args.length) return 'iptables: option "-d" requires an argument';
          if (isNeg) rule.negDestination = true;
          rule.destination = args[i];
          if (!this.validateIPSpec(rule.destination)) return `iptables: host/network \`${rule.destination}' not found`;
          break;

        case '-i': case '--in-interface':
          i++;
          if (i >= args.length) return 'iptables: option "-i" requires an argument';
          if (isNeg) rule.negInInterface = true;
          rule.inInterface = args[i];
          break;

        case '-o': case '--out-interface':
          i++;
          if (i >= args.length) return 'iptables: option "-o" requires an argument';
          if (isNeg) rule.negOutInterface = true;
          rule.outInterface = args[i];
          break;

        case '--sport': case '--source-port':
          i++;
          if (i >= args.length) return 'iptables: option "--sport" requires an argument';
          rule.sport = args[i];
          if (!this.validatePortSpec(rule.sport)) return `iptables: invalid port/service \`${rule.sport}' specified`;
          break;

        case '--dport': case '--destination-port':
          i++;
          if (i >= args.length) return 'iptables: option "--dport" requires an argument';
          rule.dport = args[i];
          if (!this.validatePortSpec(rule.dport)) return `iptables: invalid port/service \`${rule.dport}' specified`;
          break;

        case '-j': case '--jump': {
          i++;
          if (i >= args.length) return 'iptables: option "-j" requires an argument';
          rule.target = args[i];
          i++;
          // Parse target options
          while (i < args.length && args[i].startsWith('--')) {
            const optName = args[i]; i++;
            if (i < args.length && !args[i].startsWith('-')) {
              rule.targetOptions[optName] = args[i]; i++;
            } else if (i < args.length && args[i].startsWith('--')) {
              rule.targetOptions[optName] = args[i]; i++;
            } else {
              rule.targetOptions[optName] = '';
            }
          }
          continue;
        }

        case '-m': case '--match': {
          i++;
          if (i >= args.length) return 'iptables: option "-m" requires an argument';
          const mod = args[i];
          const ext: MatchExtension = { module: mod, options: new Map() };
          i++;
          while (i < args.length && args[i].startsWith('--')) {
            const on = args[i]; i++;
            if (i < args.length && !args[i].startsWith('-')) {
              ext.options.set(on, args[i]); i++;
            } else {
              ext.options.set(on, '');
            }
          }
          rule.matches.push(ext);
          continue;
        }

        default: break;
      }
      i++;
    }
    return rule;
  }

  // ─── Validation helpers ────────────────────────────────────────

  private validateIPSpec(spec: string): boolean {
    if (spec.includes('/')) {
      const [ip, prefix] = spec.split('/');
      const p = parseInt(prefix);
      if (isNaN(p) || p < 0 || p > 32) return false;
      return this.ipToNumber(ip) !== null;
    }
    return this.ipToNumber(spec) !== null;
  }

  private validatePortSpec(spec: string): boolean {
    if (spec.includes(':')) {
      const [s, e] = spec.split(':');
      const si = parseInt(s), ei = parseInt(e);
      return !isNaN(si) && !isNaN(ei) && si >= 0 && si <= 65535 && ei >= 0 && ei <= 65535;
    }
    if (spec.includes(',')) {
      return spec.split(',').every(p => { const n = parseInt(p); return !isNaN(n) && n >= 0 && n <= 65535; });
    }
    const n = parseInt(spec);
    return !isNaN(n) && n >= 0 && n <= 65535;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private rulesEqual(a: IptablesRule, b: IptablesRule): boolean {
    return a.protocol === b.protocol && a.source === b.source && a.destination === b.destination &&
      a.inInterface === b.inInterface && a.outInterface === b.outInterface &&
      a.sport === b.sport && a.dport === b.dport && a.target === b.target &&
      a.negSource === b.negSource && a.negDestination === b.negDestination &&
      a.negProtocol === b.negProtocol && a.negInInterface === b.negInInterface &&
      a.negOutInterface === b.negOutInterface &&
      a.matches.length === b.matches.length &&
      a.matches.every((m, i) => m.module === b.matches[i].module &&
        m.options.size === b.matches[i].options.size &&
        [...m.options].every(([k, v]) => b.matches[i].options.get(k) === v));
  }

  private tokenize(line: string): string[] {
    const tokens: string[] = [];
    let cur = '', inQ = false, qc = '';
    for (const ch of line) {
      if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
      else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
      else if (ch === ' ' || ch === '\t') { if (cur) { tokens.push(cur); cur = ''; } }
      else cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  private showUsage(): string {
    return [
      'iptables v1.8.7 (nf_tables)',
      '',
      'Usage: iptables [-t table] {-A|-C|-D} chain rule-specification',
      '       iptables [-t table] -I chain [rulenum] rule-specification',
      '       iptables [-t table] -R chain rulenum rule-specification',
      '       iptables [-t table] -D chain rulenum',
      '       iptables [-t table] -S [chain [rulenum]]',
      '       iptables [-t table] {-F|-L|-Z} [chain [rulenum]] [options...]',
      '       iptables [-t table] -N chain',
      '       iptables [-t table] -X [chain]',
      '       iptables [-t table] -P chain target',
      '       iptables [-t table] -E old-chain-name new-chain-name',
    ].join('\n');
  }
}
