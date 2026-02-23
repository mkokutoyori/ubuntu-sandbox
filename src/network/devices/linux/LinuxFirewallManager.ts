/**
 * LinuxFirewallManager — UFW (Uncomplicated Firewall) state manager.
 * Manages firewall rules, default policies, logging, and status.
 * Output matches real Ubuntu/Debian `ufw` behavior.
 */

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
type Direction = 'incoming' | 'outgoing';
type DefaultPolicy = 'allow' | 'deny' | 'reject';

interface UfwRule {
  action: Action;
  port: string;       // e.g. '22/tcp', '80/tcp', '53', '6000:6007/tcp'
  from: string;       // e.g. 'Anywhere', '192.168.1.100', '10.0.0.0/24'
  to: string;         // e.g. 'Anywhere'
  v6: boolean;        // IPv6 duplicate rule
}

// ─── Manager ─────────────────────────────────────────────────────────

export class LinuxFirewallManager {
  private enabled = false;
  private rules: UfwRule[] = [];
  private defaultIncoming: DefaultPolicy = 'deny';
  private defaultOutgoing: DefaultPolicy = 'allow';
  private logging = false;
  private loggingLevel = 'low';

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
      case 'reset':    return this.cmdReset();
      case 'reload':   return this.cmdReload();
      case 'logging':  return this.cmdLogging(args.slice(1));
      case 'app':      return this.cmdApp(args.slice(1));
      case 'version':  return 'ufw 0.36.1';
      default:
        return `ERROR: Invalid syntax\n\n${this.showUsage()}`;
    }
  }

  // ─── Subcommands ─────────────────────────────────────────────────

  private cmdEnable(): string {
    this.enabled = true;
    return 'Firewall is active and enabled on system startup';
  }

  private cmdDisable(): string {
    this.enabled = false;
    return 'Firewall stopped and disabled on system startup';
  }

  private cmdReset(): string {
    this.enabled = false;
    this.rules = [];
    this.defaultIncoming = 'deny';
    this.defaultOutgoing = 'allow';
    this.logging = false;
    this.loggingLevel = 'low';
    return 'Resetting all rules to installed defaults. Proceed with operation (y|n)? y\n' +
           'Backing up user rules ... done';
  }

  private cmdReload(): string {
    return 'Firewall reloaded';
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
    const v4Rules = this.rules.filter(r => !r.v6);
    const v6Rules = this.rules.filter(r => r.v6);
    const orderedRules = [...v4Rules, ...v6Rules];

    orderedRules.forEach((rule, idx) => {
      const num = numbered ? `[ ${idx + 1}] ` : '';
      const toStr = rule.v6 ? `${rule.port} (v6)` : rule.port;
      const fromStr = rule.v6 ? `${rule.from} (v6)` : rule.from;
      const actionStr = rule.action + ' IN';
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
      return `Default incoming policy changed to '${policy}'`;
    }
    if (direction === 'outgoing') {
      this.defaultOutgoing = policy;
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
      !r.v6 && r.action === parsed.action && r.port === parsed.port && r.from === parsed.from
    );
    if (dup) {
      return `Skipping adding existing rule\nSkipping adding existing rule (v6)`;
    }

    // Add IPv4 rule
    this.rules.push({ ...parsed, v6: false });
    // Add IPv6 rule
    if (parsed.from === 'Anywhere') {
      this.rules.push({ ...parsed, v6: true });
    }

    return parsed.from === 'Anywhere'
      ? 'Rule added\nRule added (v6)'
      : 'Rule added';
  }

  private parseRuleArgs(action: Action, args: string[]): UfwRule | string {
    const first = args[0];

    // ufw allow from <ip> [to any [port <port> [proto <proto>]]]
    if (first === 'from') {
      return this.parseFromRule(action, args);
    }

    // ufw allow <service_name>
    const service = SERVICE_PORTS[first];
    if (service) {
      const portStr = service.proto ? `${service.port}/${service.proto}` : service.port;
      return { action, port: portStr, from: 'Anywhere', to: 'Anywhere', v6: false };
    }

    // ufw allow <port>[/<proto>]
    // ufw allow <port1>:<port2>/<proto>
    if (/^\d+/.test(first)) {
      return { action, port: first, from: 'Anywhere', to: 'Anywhere', v6: false };
    }

    return 'ERROR: invalid rule syntax';
  }

  private parseFromRule(action: Action, args: string[]): UfwRule | string {
    // from <source> [to any [port <port> [proto <proto>]]]
    let from = 'Anywhere';
    let port = '';
    let proto = '';

    let i = 0;
    // 'from'
    if (args[i] === 'from') {
      i++;
      if (i >= args.length) return 'ERROR: missing source address';
      from = args[i] === 'any' ? 'Anywhere' : args[i];
      i++;
    }

    // 'to any'
    if (i < args.length && args[i] === 'to') {
      i++; // 'to'
      if (i < args.length && args[i] === 'any') i++; // 'any'
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

    const portStr = port
      ? (proto ? `${port}/${proto}` : port)
      : 'Anywhere';

    return { action, port: portStr, from, to: 'Anywhere', v6: false };
  }

  // ─── Delete rule ─────────────────────────────────────────────────

  private cmdDelete(args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    // ufw delete <number>
    const num = parseInt(args[0]);
    if (!isNaN(num) && args.length === 1) {
      if (num < 1 || num > this.rules.length) {
        return 'ERROR: could not find a rule matching that number';
      }
      // Find the matching IPv4 rule (numbered rules are only v4)
      const v4Rules = this.rules.filter(r => !r.v6);
      if (num < 1 || num > v4Rules.length) {
        return 'ERROR: could not find a rule matching that number';
      }
      const target = v4Rules[num - 1];
      // Remove both v4 and matching v6 rule
      this.rules = this.rules.filter(r => {
        if (r === target) return false;
        if (r.v6 && r.action === target.action && r.port === target.port && r.from === target.from) return false;
        return true;
      });
      return 'Rule deleted\nRule deleted (v6)';
    }

    // ufw delete allow|deny|reject <port>
    const action = args[0].toUpperCase() as Action;
    if (['ALLOW', 'DENY', 'REJECT', 'LIMIT'].includes(action)) {
      const ruleArgs = args.slice(1);
      const parsed = this.parseRuleArgs(action, ruleArgs);
      if (typeof parsed === 'string') return parsed;

      const before = this.rules.length;
      this.rules = this.rules.filter(r =>
        !(r.action === parsed.action && r.port === parsed.port && r.from === parsed.from)
      );
      if (this.rules.length === before) {
        return 'Could not delete non-existent rule';
      }
      return 'Rule deleted\nRule deleted (v6)';
    }

    return 'ERROR: invalid delete syntax';
  }

  // ─── Insert rule ─────────────────────────────────────────────────

  private cmdInsert(args: string[]): string {
    if (args.length < 3) return 'ERROR: wrong number of arguments';

    const pos = parseInt(args[0]);
    if (isNaN(pos) || pos < 1) {
      return 'ERROR: Invalid position \'0\'';
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
    // Insert v6 rule right after if from Anywhere
    if (parsed.from === 'Anywhere') {
      this.rules.splice(insertIdx + 1, 0, { ...parsed, v6: true });
    }

    return 'Rule inserted';
  }

  // ─── Logging ─────────────────────────────────────────────────────

  private cmdLogging(args: string[]): string {
    if (args.length === 0) return 'ERROR: wrong number of arguments';

    const level = args[0];
    if (level === 'off') {
      this.logging = false;
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

    return `Logging enabled`;
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
      ' reload                          reload firewall',
      ' reset                           reset firewall',
      ' status                          show firewall status',
      ' status numbered                 show firewall status as numbered list',
      ' status verbose                  show verbose firewall status',
      ' version                         display version information',
      ' app list                        list application profiles',
      ' app info PROFILE                show information on PROFILE',
    ].join('\n');
  }
}
