/**
 * LinuxFirewallManager — UFW (Uncomplicated Firewall) state manager.
 * Manages firewall rules, default policies, logging, and status.
 * Output matches real Ubuntu/Debian `ufw` behavior.
 * Persists configuration and rules to /etc/ufw/ in the VFS.
 * Writes log entries to /var/log/ufw.log.
 */

import type { VirtualFileSystem } from './VirtualFileSystem';

// ─── Service name → port mapping ─────────────────────────────────────
const SERVICE_PORTS: Record<string, { port: string; proto: string }> = {
  ssh: { port: '22', proto: 'tcp' },
  http: { port: '80', proto: 'tcp' },
  https: { port: '443', proto: 'tcp' },
  ftp: { port: '21', proto: 'tcp' },
  smtp: { port: '25', proto: 'tcp' },
  dns: { port: '53', proto: '' },
  pop3: { port: '110', proto: 'tcp' },
  imap: { port: '143', proto: 'tcp' },
  ntp: { port: '123', proto: 'udp' },
  mysql: { port: '3306', proto: 'tcp' },
  postgresql: { port: '5432', proto: 'tcp' },
  redis: { port: '6379', proto: 'tcp' },
  telnet: { port: '23', proto: 'tcp' },
};

// ─── App profiles ────────────────────────────────────────────────────
const APP_PROFILES: Record<string, { title: string; description: string; ports: string }> = {
  'OpenSSH': { title: 'OpenSSH', description: 'Secure Shell server', ports: '22/tcp' },
  'Apache': { title: 'Apache', description: 'Apache HTTP Server', ports: '80/tcp' },
  'Apache Full': { title: 'Apache Full', description: 'Apache HTTP + HTTPS', ports: '80,443/tcp' },
  'Apache Secure': { title: 'Apache Secure', description: 'Apache HTTPS', ports: '443/tcp' },
  'Nginx HTTP': { title: 'Nginx HTTP', description: 'Nginx HTTP Server', ports: '80/tcp' },
  'Nginx Full': { title: 'Nginx Full', description: 'Nginx HTTP + HTTPS', ports: '80,443/tcp' },
  'Nginx HTTPS': { title: 'Nginx HTTPS', description: 'Nginx HTTPS Server', ports: '443/tcp' },
};

// ─── Types ───────────────────────────────────────────────────────────

type Action = 'ALLOW' | 'DENY' | 'REJECT' | 'LIMIT';
type RuleDirection = 'in' | 'out';
type DefaultPolicy = 'allow' | 'deny' | 'reject';

interface UfwRule {
  action: Action;
  direction: RuleDirection;
  port: string;       // e.g. '22/tcp', '80/tcp', '53', '6000:6007/tcp'
  from: string;       // e.g. 'Anywhere', '192.168.1.100', '10.0.0.0/24'
  to: string;         // e.g. 'Anywhere', '192.168.1.1'
  iface: string;      // e.g. '', 'eth0', 'ens33' — empty = all interfaces
  v6: boolean;        // IPv6 duplicate rule
  comment: string;    // optional comment
}

// ─── Packet filtering types ─────────────────────────────────────────

export type FirewallVerdict = 'accept' | 'drop' | 'reject';

export interface PacketInfo {
  direction: 'in' | 'out';
  protocol: number;         // 1=ICMP, 6=TCP, 17=UDP
  srcIP: string;
  dstIP: string;
  srcPort: number;          // 0 for ICMP
  dstPort: number;          // 0 for ICMP
  iface: string;            // interface name (e.g. 'eth0')
  isV6?: boolean;           // true for IPv6 packets (uses v6 rules)
}

// ─── Manager ─────────────────────────────────────────────────────────

export class LinuxFirewallManager {
  private vfs: VirtualFileSystem | null = null;
  private enabled = false;
  private rules: UfwRule[] = [];
  private defaultIncoming: DefaultPolicy = 'deny';
  private defaultOutgoing: DefaultPolicy = 'allow';
  private logging = false;
  private loggingLevel = 'low';

  // Rate limiting state: key = "srcIP:ruleIndex" → timestamps of recent hits
  private rateLimitHits: Map<string, number[]> = new Map();
  private readonly RATE_LIMIT_MAX = 6;      // Max connections
  private readonly RATE_LIMIT_WINDOW = 30000; // 30 seconds (ms)

  constructor(vfs?: VirtualFileSystem) {
    if (vfs) this.vfs = vfs;
  }

  // ─── Real packet filtering ─────────────────────────────────────

  /**
   * Evaluate firewall rules against an actual packet.
   * Returns 'accept', 'drop', or 'reject'.
   * If firewall is disabled, always accepts.
   */
  filterPacket(pkt: PacketInfo): FirewallVerdict {
    if (!this.enabled) return 'accept';

    // Get rules matching this direction and IP version
    const useV6 = pkt.isV6 === true;
    const candidateRules = this.rules.filter(r =>
      r.v6 === useV6 && r.direction === pkt.direction
    );

    // First-match wins (like real iptables/ufw)
    for (let i = 0; i < candidateRules.length; i++) {
      const rule = candidateRules[i];
      if (this.ruleMatchesPacket(rule, pkt)) {
        this.logPacketVerdict(pkt, rule);
        if (rule.action === 'LIMIT') {
          return this.evaluateRateLimit(pkt, i);
        }
        return this.actionToVerdict(rule.action);
      }
    }

    // No rule matched → apply default policy
    const defaultPolicy = pkt.direction === 'in' ? this.defaultIncoming : this.defaultOutgoing;
    return defaultPolicy === 'allow' ? 'accept' : (defaultPolicy === 'reject' ? 'reject' : 'drop');
  }

  /** Check whether UFW is currently enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  private ruleMatchesPacket(rule: UfwRule, pkt: PacketInfo): boolean {
    // Interface check
    if (rule.iface && rule.iface !== pkt.iface) return false;

    // Source IP check
    if (rule.from !== 'Anywhere') {
      if (!this.ipMatchesSpec(pkt.srcIP, rule.from)) return false;
    }

    // Destination IP check
    if (rule.to !== 'Anywhere') {
      if (!this.ipMatchesSpec(pkt.dstIP, rule.to)) return false;
    }

    // Port/protocol check
    if (rule.port !== 'Anywhere') {
      if (!this.portMatchesRule(rule.port, pkt)) return false;
    }

    return true;
  }

  private ipMatchesSpec(ip: string, spec: string): boolean {
    // Exact IP match
    if (!spec.includes('/')) return ip === spec;

    // CIDR match (e.g. 10.0.0.0/24)
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

  private portMatchesRule(rulePort: string, pkt: PacketInfo): boolean {
    // Parse rule port: "22/tcp", "53", "6000:6007/tcp", "80,443/tcp"
    const protoMatch = rulePort.match(/^(.+)\/(tcp|udp)$/);
    const portSpec = protoMatch ? protoMatch[1] : rulePort;
    const ruleProto = protoMatch ? protoMatch[2] : null;

    // Protocol check: if rule specifies tcp/udp, packet protocol must match
    if (ruleProto) {
      const protoNum = ruleProto === 'tcp' ? 6 : 17;
      if (pkt.protocol !== protoNum) return false;
    } else {
      // No protocol specified — rule applies to both tcp and udp
      if (pkt.protocol !== 6 && pkt.protocol !== 17) return false;
    }

    // Port range: "6000:6007"
    if (portSpec.includes(':')) {
      const [startStr, endStr] = portSpec.split(':');
      const start = parseInt(startStr);
      const end = parseInt(endStr);
      return pkt.dstPort >= start && pkt.dstPort <= end;
    }

    // Multi-port: "80,443"
    if (portSpec.includes(',')) {
      const ports = portSpec.split(',').map(p => parseInt(p));
      return ports.includes(pkt.dstPort);
    }

    // Single port
    return pkt.dstPort === parseInt(portSpec);
  }

  private actionToVerdict(action: Action): FirewallVerdict {
    switch (action) {
      case 'ALLOW': return 'accept';
      case 'DENY': return 'drop';
      case 'REJECT': return 'reject';
      case 'LIMIT': return 'accept'; // Fallback (real LIMIT uses evaluateRateLimit)
    }
  }

  /**
   * Evaluate rate limiting: allow up to RATE_LIMIT_MAX hits per source IP
   * within RATE_LIMIT_WINDOW. Beyond that, drop.
   */
  private evaluateRateLimit(pkt: PacketInfo, ruleIdx: number): FirewallVerdict {
    const key = `${pkt.srcIP}:${ruleIdx}`;
    const now = Date.now();

    let hits = this.rateLimitHits.get(key);
    if (!hits) {
      hits = [];
      this.rateLimitHits.set(key, hits);
    }

    // Purge expired entries
    const cutoff = now - this.RATE_LIMIT_WINDOW;
    while (hits.length > 0 && hits[0] < cutoff) {
      hits.shift();
    }

    if (hits.length >= this.RATE_LIMIT_MAX) {
      return 'drop'; // Rate limit exceeded
    }

    hits.push(now);
    return 'accept';
  }

  private logPacketVerdict(pkt: PacketInfo, rule: UfwRule): void {
    if (!this.logging) return;
    const proto = pkt.protocol === 6 ? 'TCP' : pkt.protocol === 17 ? 'UDP' : 'ICMP';
    const msg = `[UFW BLOCK] IN=${pkt.direction === 'in' ? pkt.iface : ''} OUT=${pkt.direction === 'out' ? pkt.iface : ''} SRC=${pkt.srcIP} DST=${pkt.dstIP} PROTO=${proto}` +
      (pkt.dstPort ? ` DPT=${pkt.dstPort}` : '') +
      (pkt.srcPort ? ` SPT=${pkt.srcPort}` : '');
    this.logUfw(msg);
  }

  /**
   * Execute a ufw subcommand. Returns output string.
   */
  execute(args: string[]): string {
    if (args.length === 0) {
      return this.showUsage();
    }

    const sub = args[0];

    switch (sub) {
      case 'enable':   return this.cmdEnable();
      case 'disable':  return this.cmdDisable();
      case 'status':   return this.cmdStatus(args.slice(1));
      case 'default':  return this.cmdDefault(args.slice(1));
      case 'allow':    return this.cmdAddRule('ALLOW', args.slice(1));
      case 'deny':     return this.cmdAddRule('DENY', args.slice(1));
      case 'reject':   return this.cmdAddRule('REJECT', args.slice(1));
      case 'limit':    return this.cmdAddRule('LIMIT', args.slice(1));
      case 'delete':   return this.cmdDelete(args.slice(1));
      case 'insert':   return this.cmdInsert(args.slice(1));
      case 'prepend':  return this.cmdPrepend(args.slice(1));
      case 'reset':    return this.cmdReset();
      case 'reload':   return this.cmdReload();
      case 'logging':  return this.cmdLogging(args.slice(1));
      case 'app':      return this.cmdApp(args.slice(1));
      case 'show':     return this.cmdShow(args.slice(1));
      case 'version':  return 'ufw 0.36.1';
      default:
        return `ERROR: Invalid syntax\n\n${this.showUsage()}`;
    }
  }

  // ─── Subcommands ─────────────────────────────────────────────────

  private cmdEnable(): string {
    this.enabled = true;
    this.syncToVfs();
    this.logUfw('UFW enabled');
    return 'Firewall is active and enabled on system startup';
  }

  private cmdDisable(): string {
    this.logUfw('UFW disabled');
    this.enabled = false;
    this.syncToVfs();
    return 'Firewall stopped and disabled on system startup';
  }

  private cmdReset(): string {
    this.enabled = false;
    this.rules = [];
    this.defaultIncoming = 'deny';
    this.defaultOutgoing = 'allow';
    this.logging = false;
    this.loggingLevel = 'low';
    this.syncToVfs();
    return 'Resetting all rules to installed defaults. Proceed with operation (y|n)? y\n' +
           'Backing up user rules ... done';
  }

  private cmdReload(): string {
    this.loadFromVfs();
    this.syncToVfs();
    return 'Firewall reloaded';
  }

  /** Re-read configuration from /etc/ufw/ufw.conf in the VFS. */
  private loadFromVfs(): void {
    if (!this.vfs) return;

    const ufwConf = this.vfs.readFile('/etc/ufw/ufw.conf');
    if (ufwConf) {
      // Parse ENABLED=yes/no
      const enabledMatch = ufwConf.match(/ENABLED\s*=\s*(yes|no)/);
      if (enabledMatch) {
        this.enabled = enabledMatch[1] === 'yes';
      }

      // Parse LOGLEVEL=off|low|medium|high|full
      const logMatch = ufwConf.match(/LOGLEVEL\s*=\s*(\w+)/);
      if (logMatch) {
        const level = logMatch[1];
        if (level === 'off') {
          this.logging = false;
        } else if (['low', 'medium', 'high', 'full'].includes(level)) {
          this.logging = true;
          this.loggingLevel = level;
        }
      }
    }
  }

  private cmdStatus(args: string[]): string {
    if (!this.enabled) {
      return 'Status: inactive';
    }

    const verbose = args[0] === 'verbose';
    const numbered = args[0] === 'numbered';

    const lines: string[] = ['Status: active'];

    if (verbose) {
      lines.push(`Logging: ${this.logging ? `on (${this.loggingLevel})` : 'off'}`);
      lines.push(`Default: ${this.defaultIncoming} (incoming), ${this.defaultOutgoing} (outgoing), disabled (routed)`);
      lines.push(`New profiles: skip`);
      lines.push('');
    }

    if (this.rules.length === 0) {
      return lines.join('\n');
    }

    // Column widths
    const toWidth = 27;
    const actionWidth = 16;

    // Header
    const header = `${'To'.padEnd(toWidth)}${'Action'.padEnd(actionWidth)}From`;
    const separator = `${'--'.padEnd(toWidth)}${'------'.padEnd(actionWidth)}----`;
    lines.push(header);
    lines.push(separator);

    // Rules — show v4 first, then v6 (like real ufw)
    const orderedRules = this.getOrderedRules();

    orderedRules.forEach((rule, idx) => {
      const num = numbered ? `[ ${idx + 1}] ` : '';
      const v6Tag = rule.v6 ? ' (v6)' : '';
      const ifaceTag = rule.iface ? ` on ${rule.iface}` : '';
      // 'To' column: show destination if specific, otherwise just port
      const destPart = rule.to !== 'Anywhere' ? `${rule.to} ${rule.port}` : rule.port;
      const toStr = `${destPart}${v6Tag}`;
      const fromStr = `${rule.from}${v6Tag}`;
      const dirStr = rule.direction === 'out' ? 'OUT' : 'IN';
      const actionStr = `${rule.action} ${dirStr}${ifaceTag}`;
      lines.push(`${num}${toStr.padEnd(toWidth)}${actionStr.padEnd(actionWidth)}${fromStr}`);
    });

    return lines.join('\n');
  }

  private cmdDefault(args: string[]): string {
    if (args.length < 2) {
      return 'ERROR: wrong number of arguments';
    }

    const policy = args[0];
    const direction = args[1];

    if (policy !== 'allow' && policy !== 'deny' && policy !== 'reject') {
      return "ERROR: unsupported policy '" + policy + "'";
    }

    if (direction === 'incoming') {
      this.defaultIncoming = policy;
      this.syncToVfs();
      return `Default incoming policy changed to '${policy}'`;
    }
    if (direction === 'outgoing') {
      this.defaultOutgoing = policy;
      this.syncToVfs();
      return `Default outgoing policy changed to '${policy}'`;
    }

    return "ERROR: unsupported direction '" + direction + "'";
  }

  // ─── Add rule (allow/deny/reject/limit) ──────────────────────────

  private cmdAddRule(action: Action, args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    const parsed = this.parseRuleArgs(action, args);
    if (typeof parsed === 'string') return parsed; // Error message

    // Check for duplicates
    const dup = this.rules.find(r =>
      !r.v6 && r.action === parsed.action && r.port === parsed.port &&
      r.from === parsed.from && r.to === parsed.to &&
      r.direction === parsed.direction && r.iface === parsed.iface
    );
    if (dup) {
      const addsV6 = this.ruleGetsV6(parsed);
      return addsV6
        ? 'Skipping adding existing rule\nSkipping adding existing rule (v6)'
        : 'Skipping adding existing rule';
    }

    // Add IPv4 rule
    this.rules.push({ ...parsed, v6: false });
    // Add IPv6 duplicate if source/dest are not IPv4-specific
    const addsV6 = this.ruleGetsV6(parsed);
    if (addsV6) {
      this.rules.push({ ...parsed, v6: true });
    }

    this.syncToVfs();
    return addsV6
      ? 'Rule added\nRule added (v6)'
      : 'Rule added';
  }

  private ruleGetsV6(rule: UfwRule): boolean {
    // IPv6 duplicate is added only when from and to are not IPv4-specific
    const isIpv4 = (addr: string) => /^\d+\.\d+\.\d+\.\d+/.test(addr);
    return !isIpv4(rule.from) && !isIpv4(rule.to);
  }

  private validatePort(portStr: string): string | null {
    // portStr can be: "22", "22/tcp", "6000:6007/tcp", "6000:6007/udp"
    const match = portStr.match(/^(\d+)(?::(\d+))?(\/(?:tcp|udp))?$/);
    if (!match) return `ERROR: Invalid port '${portStr}'`;

    const p1 = parseInt(match[1]);
    const p2 = match[2] ? parseInt(match[2]) : null;

    if (p1 < 1 || p1 > 65535) return `ERROR: Invalid port '${portStr}'`;
    if (p2 !== null) {
      if (p2 < 1 || p2 > 65535) return `ERROR: Invalid port '${portStr}'`;
      if (p1 >= p2) return `ERROR: Invalid port range '${portStr}'`;
    }
    return null; // valid
  }

  private parseRuleArgs(action: Action, args: string[]): UfwRule | string {
    let i = 0;

    // Parse optional direction: in | out
    let direction: RuleDirection = 'in';
    if (args[i] === 'in' || args[i] === 'out') {
      direction = args[i] as RuleDirection;
      i++;
    }

    // Parse optional interface: on <iface>
    let iface = '';
    if (i < args.length && args[i] === 'on') {
      i++;
      if (i >= args.length) return 'ERROR: missing interface name';
      iface = args[i];
      i++;
    }

    if (i >= args.length) return 'ERROR: wrong number of arguments';
    const first = args[i];
    const remaining = args.slice(i);

    // ufw allow [in|out] [on <iface>] from <ip> [to <dest> [port <port> [proto <proto>]]]
    if (first === 'from') {
      return this.parseFromRule(action, direction, iface, remaining);
    }

    // ufw allow [in|out] [on <iface>] <service_name>
    const service = SERVICE_PORTS[first];
    if (service) {
      const portStr = service.proto ? `${service.port}/${service.proto}` : service.port;
      return { action, direction, port: portStr, from: 'Anywhere', to: 'Anywhere', iface, v6: false, comment: '' };
    }

    // ufw allow [in|out] [on <iface>] <app_profile_name>
    const profile = APP_PROFILES[remaining.join(' ')];
    if (profile) {
      return { action, direction, port: profile.ports, from: 'Anywhere', to: 'Anywhere', iface, v6: false, comment: '' };
    }

    // ufw allow [in|out] [on <iface>] <port>[/<proto>]
    // ufw allow [in|out] [on <iface>] <port1>:<port2>/<proto>
    if (/^\d+/.test(first)) {
      const err = this.validatePort(first);
      if (err) return err;
      return { action, direction, port: first, from: 'Anywhere', to: 'Anywhere', iface, v6: false, comment: '' };
    }

    return 'ERROR: invalid rule syntax';
  }

  private parseFromRule(action: Action, direction: RuleDirection, iface: string, args: string[]): UfwRule | string {
    // from <source> [to <dest>|any [port <port> [proto <proto>]]] [comment <text>]
    let from = 'Anywhere';
    let to = 'Anywhere';
    let port = '';
    let proto = '';
    let comment = '';

    let i = 0;
    // 'from'
    if (args[i] === 'from') {
      i++;
      if (i >= args.length) return 'ERROR: missing source address';
      from = args[i] === 'any' ? 'Anywhere' : args[i];
      i++;
    }

    // 'to <dest>'
    if (i < args.length && args[i] === 'to') {
      i++; // 'to'
      if (i >= args.length) return 'ERROR: missing destination address';
      to = args[i] === 'any' ? 'Anywhere' : args[i];
      i++;
    }

    // 'port <port>'
    if (i < args.length && args[i] === 'port') {
      i++;
      if (i >= args.length) return 'ERROR: missing port number';
      port = args[i];
      i++;
    }

    // 'proto <proto>'
    if (i < args.length && args[i] === 'proto') {
      i++;
      if (i >= args.length) return 'ERROR: missing protocol';
      proto = args[i];
      i++;
    }

    // 'comment <text>'
    if (i < args.length && args[i] === 'comment') {
      i++;
      if (i >= args.length) return 'ERROR: missing comment text';
      comment = args.slice(i).join(' ');
      i = args.length;
    }

    const portStr = port
      ? (proto ? `${port}/${proto}` : port)
      : 'Anywhere';

    // Validate port if specified
    if (port) {
      const fullPort = proto ? `${port}/${proto}` : port;
      const err = this.validatePort(fullPort.match(/^\d/) ? fullPort : port);
      if (err) return err;
    }

    return { action, direction, port: portStr, from, to, iface, v6: false, comment };
  }

  private getOrderedRules(): UfwRule[] {
    const v4Rules = this.rules.filter(r => !r.v6);
    const v6Rules = this.rules.filter(r => r.v6);
    return [...v4Rules, ...v6Rules];
  }

  // ─── Delete rule ─────────────────────────────────────────────────

  private cmdDelete(args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    // ufw delete <number>
    const num = parseInt(args[0]);
    if (!isNaN(num) && args.length === 1) {
      const ordered = this.getOrderedRules();
      if (num < 1 || num > ordered.length) {
        return 'ERROR: could not find a rule matching that number';
      }
      const target = ordered[num - 1];
      // If deleting a v4 rule, also remove its v6 counterpart
      if (!target.v6) {
        const hasV6 = this.rules.some(r =>
          r.v6 && r.action === target.action && r.port === target.port &&
          r.from === target.from && r.direction === target.direction && r.iface === target.iface
        );
        this.rules = this.rules.filter(r => {
          if (r === target) return false;
          if (r.v6 && r.action === target.action && r.port === target.port &&
              r.from === target.from && r.direction === target.direction && r.iface === target.iface) return false;
          return true;
        });
        this.syncToVfs();
        return hasV6 ? 'Rule deleted\nRule deleted (v6)' : 'Rule deleted';
      }
      // Deleting a v6 rule directly (only removes that one)
      this.rules = this.rules.filter(r => r !== target);
      this.syncToVfs();
      return 'Rule deleted (v6)';
    }

    // ufw delete allow|deny|reject <port>
    const action = args[0].toUpperCase() as Action;
    if (['ALLOW', 'DENY', 'REJECT', 'LIMIT'].includes(action)) {
      const ruleArgs = args.slice(1);
      const parsed = this.parseRuleArgs(action, ruleArgs);
      if (typeof parsed === 'string') return parsed;

      const hadV6 = this.rules.some(r =>
        r.v6 && r.action === parsed.action && r.port === parsed.port &&
        r.from === parsed.from && r.direction === parsed.direction && r.iface === parsed.iface
      );
      const before = this.rules.length;
      this.rules = this.rules.filter(r =>
        !(r.action === parsed.action && r.port === parsed.port &&
          r.from === parsed.from && r.direction === parsed.direction && r.iface === parsed.iface)
      );
      if (this.rules.length === before) {
        return 'Could not delete non-existent rule';
      }
      this.syncToVfs();
      return hadV6 ? 'Rule deleted\nRule deleted (v6)' : 'Rule deleted';
    }

    return 'ERROR: invalid delete syntax';
  }

  // ─── Insert rule ─────────────────────────────────────────────────

  private cmdInsert(args: string[]): string {
    if (args.length < 3) return 'ERROR: wrong number of arguments';

    const pos = parseInt(args[0]);
    if (isNaN(pos) || pos < 1) {
      return `ERROR: Invalid position '${args[0]}'`;
    }

    const action = args[1].toUpperCase() as Action;
    if (!['ALLOW', 'DENY', 'REJECT', 'LIMIT'].includes(action)) {
      return 'ERROR: invalid action';
    }

    const ruleArgs = args.slice(2);
    const parsed = this.parseRuleArgs(action, ruleArgs);
    if (typeof parsed === 'string') return parsed;

    // Count v4 rules for position
    const v4Rules: number[] = [];
    this.rules.forEach((r, idx) => {
      if (!r.v6) v4Rules.push(idx);
    });

    if (pos > v4Rules.length + 1) {
      return `ERROR: Invalid position '${pos}'`;
    }

    // Find the actual index in the array
    const insertIdx = pos <= v4Rules.length ? v4Rules[pos - 1] : this.rules.length;

    // Insert v4 rule
    this.rules.splice(insertIdx, 0, { ...parsed, v6: false });
    // Insert v6 rule right after if applicable
    if (this.ruleGetsV6(parsed)) {
      this.rules.splice(insertIdx + 1, 0, { ...parsed, v6: true });
    }

    this.syncToVfs();
    return 'Rule inserted';
  }

  // ─── Prepend rule ───────────────────────────────────────────────

  private cmdPrepend(args: string[]): string {
    if (args.length < 2) return 'ERROR: wrong number of arguments';

    const action = args[0].toUpperCase() as Action;
    if (!['ALLOW', 'DENY', 'REJECT', 'LIMIT'].includes(action)) {
      return 'ERROR: invalid action';
    }

    const ruleArgs = args.slice(1);
    const parsed = this.parseRuleArgs(action, ruleArgs);
    if (typeof parsed === 'string') return parsed;

    // Prepend = insert at position 0
    this.rules.unshift({ ...parsed, v6: false });
    if (this.ruleGetsV6(parsed)) {
      // Insert v6 right after the v4 rule
      this.rules.splice(1, 0, { ...parsed, v6: true });
    }

    this.syncToVfs();
    return 'Rule prepended';
  }

  // ─── Logging ─────────────────────────────────────────────────────

  private cmdLogging(args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    const level = args[0];
    if (level === 'off') {
      this.logging = false;
      this.syncToVfs();
      return 'Logging disabled';
    }

    this.logging = true;
    if (['low', 'medium', 'high', 'full'].includes(level)) {
      this.loggingLevel = level;
    } else if (level === 'on') {
      this.loggingLevel = 'low';
    } else {
      return `ERROR: unsupported logging level '${level}'`;
    }

    this.syncToVfs();
    return `Logging enabled (${this.loggingLevel})`;
  }

  // ─── App profiles ────────────────────────────────────────────────

  private cmdApp(args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    if (args[0] === 'list') {
      const names = Object.keys(APP_PROFILES);
      return 'Available applications:\n' + names.map(n => `  ${n}`).join('\n');
    }

    if (args[0] === 'info') {
      const name = args.slice(1).join(' ');
      const profile = APP_PROFILES[name];
      if (!profile) {
        return `ERROR: Could not find a profile matching '${name}'`;
      }
      return [
        `Profile: ${profile.title}`,
        `Title: ${profile.title}`,
        `Description: ${profile.description}`,
        '',
        `Ports:`,
        `  ${profile.ports}`,
      ].join('\n');
    }

    return 'ERROR: invalid app command';
  }

  // ─── Show subcommands ───────────────────────────────────────────

  private cmdShow(args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    switch (args[0]) {
      case 'raw':      return this.cmdShowRaw();
      case 'added':    return this.cmdShowAdded();
      case 'listening': return this.cmdShowListening();
      default:
        return `ERROR: unsupported show command '${args[0]}'`;
    }
  }

  private cmdShowRaw(): string {
    const lines: string[] = [];
    lines.push('IPV4 (raw):');
    lines.push('Chain ufw-user-input (1 references)');
    lines.push(' pkts bytes target     prot opt in     out     source               destination');

    const v4Rules = this.rules.filter(r => !r.v6);
    for (const rule of v4Rules) {
      const chain = rule.direction === 'out' ? 'ufw-user-output' : 'ufw-user-input';
      const target = rule.action === 'ALLOW' ? 'ACCEPT' : rule.action === 'DENY' ? 'DROP' : rule.action;
      const proto = this.extractProtoFromPort(rule.port);
      const portNum = this.extractPortNum(rule.port);
      const src = rule.from === 'Anywhere' ? '0.0.0.0/0' : rule.from;
      const dst = rule.to === 'Anywhere' ? '0.0.0.0/0' : rule.to;
      const dpt = portNum ? ` dpt:${portNum}` : '';
      const iface = rule.iface || '*';
      lines.push(`    0     0 ${target.padEnd(10)} ${(proto || 'all').padEnd(4)} opt ${rule.direction === 'in' ? iface.padEnd(6) : '*'.padEnd(6)} ${rule.direction === 'out' ? iface.padEnd(6) : '*'.padEnd(6)} ${src.padEnd(20)} ${dst}${dpt}`);
    }

    lines.push('');
    lines.push('Chain ufw-user-output (1 references)');
    lines.push(' pkts bytes target     prot opt in     out     source               destination');

    const v4Out = v4Rules.filter(r => r.direction === 'out');
    for (const rule of v4Out) {
      const target = rule.action === 'ALLOW' ? 'ACCEPT' : rule.action === 'DENY' ? 'DROP' : rule.action;
      const proto = this.extractProtoFromPort(rule.port);
      const portNum = this.extractPortNum(rule.port);
      const src = rule.from === 'Anywhere' ? '0.0.0.0/0' : rule.from;
      const dst = rule.to === 'Anywhere' ? '0.0.0.0/0' : rule.to;
      const dpt = portNum ? ` dpt:${portNum}` : '';
      const iface = rule.iface || '*';
      lines.push(`    0     0 ${target.padEnd(10)} ${(proto || 'all').padEnd(4)} opt ${'*'.padEnd(6)} ${iface.padEnd(6)} ${src.padEnd(20)} ${dst}${dpt}`);
    }

    return lines.join('\n');
  }

  private cmdShowAdded(): string {
    const lines: string[] = ['Added user rules (see \'ufw status\' for running firewall):'];
    const v4Rules = this.rules.filter(r => !r.v6);
    for (const rule of v4Rules) {
      const parts: string[] = ['ufw'];
      parts.push(rule.action.toLowerCase());
      if (rule.direction !== 'in') parts.push(rule.direction);
      if (rule.iface) {
        parts.push('on');
        parts.push(rule.iface);
      }
      if (rule.from !== 'Anywhere' || rule.to !== 'Anywhere') {
        parts.push('from');
        parts.push(rule.from === 'Anywhere' ? 'any' : rule.from);
        if (rule.to !== 'Anywhere' || rule.port !== 'Anywhere') {
          parts.push('to');
          parts.push(rule.to === 'Anywhere' ? 'any' : rule.to);
        }
        if (rule.port !== 'Anywhere') {
          const portMatch = rule.port.match(/^(.+)\/(tcp|udp)$/);
          if (portMatch) {
            parts.push('port');
            parts.push(portMatch[1]);
            parts.push('proto');
            parts.push(portMatch[2]);
          } else {
            parts.push('port');
            parts.push(rule.port);
          }
        }
      } else {
        parts.push(rule.port);
      }
      lines.push(parts.join(' '));
    }
    return lines.join('\n');
  }

  private cmdShowListening(): string {
    // Simulated listening ports (UFW doesn't actually know what's listening)
    const lines: string[] = [];
    lines.push('tcp:');
    lines.push('  22 [ ssh ]');
    lines.push('udp:');
    lines.push('  (none)');
    return lines.join('\n');
  }

  private extractProtoFromPort(port: string): string | null {
    const match = port.match(/\/(tcp|udp)$/);
    return match ? match[1] : null;
  }

  private extractPortNum(port: string): string | null {
    if (port === 'Anywhere') return null;
    const match = port.match(/^(\d[\d:,]*)/);
    return match ? match[1] : null;
  }

  // ─── VFS persistence ─────────────────────────────────────────────

  private syncToVfs(): void {
    if (!this.vfs) return;

    // Write /etc/ufw/ufw.conf
    const ufwConf = [
      '# /etc/ufw/ufw.conf',
      '#',
      '',
      '# Set to yes to start on boot',
      `ENABLED=${this.enabled ? 'yes' : 'no'}`,
      '',
      "# Please use the 'ufw' command to set the loglevel.",
      '# Loglevel is matched on a snmp-like basis.',
      `LOGLEVEL=${this.logging ? this.loggingLevel : 'off'}`,
      '',
    ].join('\n');
    this.vfs.writeFile('/etc/ufw/ufw.conf', ufwConf, 0, 0, 0o022);

    // Write /etc/ufw/user.rules (IPv4)
    const v4Rules = this.rules.filter(r => !r.v6);
    this.vfs.writeFile('/etc/ufw/user.rules', this.generateIptablesRules(v4Rules, false), 0, 0, 0o022);

    // Write /etc/ufw/user6.rules (IPv6)
    const v6Rules = this.rules.filter(r => r.v6);
    this.vfs.writeFile('/etc/ufw/user6.rules', this.generateIptablesRules(v6Rules, true), 0, 0, 0o022);
  }

  private generateIptablesRules(rules: UfwRule[], ipv6: boolean): string {
    const prefix = ipv6 ? 'ufw6' : 'ufw';
    const lines: string[] = [
      '*filter',
      `:${prefix}-user-input - [0:0]`,
      `:${prefix}-user-output - [0:0]`,
      `:${prefix}-user-forward - [0:0]`,
      `:${prefix}-user-limit-accept - [0:0]`,
    ];

    // Default policies
    lines.push(`### default incoming: ${this.defaultIncoming}`);
    lines.push(`### default outgoing: ${this.defaultOutgoing}`);
    lines.push('');

    for (const rule of rules) {
      const chain = rule.direction === 'out' ? `${prefix}-user-output` : `${prefix}-user-input`;
      const target = this.actionToIptablesTarget(rule.action, prefix);
      const parts: string[] = [`-A ${chain}`];

      // Interface
      if (rule.iface) {
        parts.push(rule.direction === 'out' ? `-o ${rule.iface}` : `-i ${rule.iface}`);
      }

      // Protocol & port
      const portMatch = rule.port.match(/^(.+)\/(tcp|udp)$/);
      if (portMatch) {
        parts.push(`-p ${portMatch[2]} --dport ${portMatch[1]}`);
      } else if (rule.port !== 'Anywhere' && /^\d+/.test(rule.port)) {
        parts.push(`-p tcp --dport ${rule.port}`);
        parts.push(`-p udp --dport ${rule.port}`);
      }

      // Source
      if (rule.from !== 'Anywhere') {
        parts.push(`-s ${rule.from}`);
      }

      // Destination
      if (rule.to !== 'Anywhere') {
        parts.push(`-d ${rule.to}`);
      }

      parts.push(`-j ${target}`);

      // Comment
      if (rule.comment) {
        parts.push(`-m comment --comment '${rule.comment}'`);
      }

      lines.push(parts.join(' '));
    }

    lines.push('COMMIT');
    lines.push('');
    return lines.join('\n');
  }

  private actionToIptablesTarget(action: Action, prefix: string): string {
    switch (action) {
      case 'ALLOW': return 'ACCEPT';
      case 'DENY': return 'DROP';
      case 'REJECT': return 'REJECT';
      case 'LIMIT': return `${prefix}-user-limit-accept`;
    }
  }

  // ─── Logging to /var/log/ufw.log ───────────────────────────────

  private logUfw(message: string): void {
    if (!this.vfs) return;

    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const ts = `${months[now.getMonth()]} ${String(now.getDate()).padStart(2, ' ')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const line = `${ts} localhost kernel: [UFW] ${message}`;

    const existing = this.vfs.readFile('/var/log/ufw.log');
    if (existing !== null) {
      this.vfs.writeFile('/var/log/ufw.log', existing + line + '\n', 0, 0, 0o022);
    } else {
      this.vfs.createFileAt('/var/log/ufw.log', line + '\n', 0o640, 0, 4);
    }
  }

  // ─── Usage ───────────────────────────────────────────────────────

  private showUsage(): string {
    return [
      'Usage: ufw COMMAND',
      '',
      'Commands:',
      ' enable                          enables the firewall',
      ' disable                         disables the firewall',
      ' default ARG                     set default policy',
      ' logging LEVEL                   set logging to LEVEL',
      ' allow ARGS                      add allow rule',
      ' deny ARGS                       add deny rule',
      ' reject ARGS                     add reject rule',
      ' limit ARGS                      add limit rule',
      ' delete RULE|NUM                 delete RULE',
      ' insert NUM RULE                 insert RULE at NUM',
      ' prepend RULE                    prepend RULE to top',
      ' reload                          reload firewall',
      ' reset                           reset firewall',
      ' show ARG                        show firewall report',
      ' status                          show firewall status',
      ' status numbered                 show firewall status as numbered list',
      ' status verbose                  show verbose firewall status',
      ' version                         display version information',
      ' app list                        list application profiles',
      ' app info PROFILE                show information on PROFILE',
    ].join('\n');
  }
}
