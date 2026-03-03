/**
 * LinuxIptablesManager — iptables (netfilter) state manager.
 * Faithfully reproduces real Linux iptables command behavior.
 * Manages tables (filter, nat, mangle, raw), chains, rules, policies,
 * match extensions, and targets.
 */

import type { VirtualFileSystem } from './VirtualFileSystem';

// ─── Types ───────────────────────────────────────────────────────────

type TableName = 'filter' | 'nat' | 'mangle' | 'raw';
type BuiltinPolicy = 'ACCEPT' | 'DROP';

interface IptablesMatchExtension {
  module: string;               // e.g. 'state', 'conntrack', 'multiport', 'comment', 'limit', 'mac', 'iprange'
  options: Map<string, string>; // e.g. '--state' => 'ESTABLISHED,RELATED'
}

interface IptablesTargetOptions {
  [key: string]: string; // e.g. '--reject-with' => 'icmp-port-unreachable', '--log-prefix' => '"INPUT_DROP: "'
}

interface IptablesRule {
  protocol: string;       // 'tcp', 'udp', 'icmp', 'all', ''
  source: string;         // '0.0.0.0/0' or specific IP/CIDR
  destination: string;    // '0.0.0.0/0' or specific IP/CIDR
  inInterface: string;    // '' or 'eth0', etc.
  outInterface: string;   // '' or 'eth0', etc.
  sport: string;          // '' or '1024' or '1024:65535'
  dport: string;          // '' or '22' or '6000:6007'
  target: string;         // 'ACCEPT', 'DROP', 'REJECT', 'LOG', 'MASQUERADE', 'DNAT', 'SNAT', 'REDIRECT', 'RETURN', or chain name
  targetOptions: IptablesTargetOptions;
  matches: IptablesMatchExtension[];
  negSource: boolean;
  negDestination: boolean;
  negProtocol: boolean;
  negInInterface: boolean;
  negOutInterface: boolean;
  // Counters
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

const VALID_TABLES = new Set<string>(['filter', 'nat', 'mangle', 'raw']);

// ─── Manager ─────────────────────────────────────────────────────────

export class LinuxIptablesManager {
  private vfs: VirtualFileSystem | null = null;
  private tables: Map<TableName, IptablesTable> = new Map();

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

  // ─── Main entry point ─────────────────────────────────────────

  execute(args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      return { output: this.showUsage(), exitCode: 2 };
    }

    // Parse table option (-t)
    let tableName: TableName = 'filter';
    const argsCopy = [...args];
    const tIdx = argsCopy.indexOf('-t');
    if (tIdx !== -1 && tIdx + 1 < argsCopy.length) {
      const tName = argsCopy[tIdx + 1];
      if (!VALID_TABLES.has(tName)) {
        return { output: `iptables v1.8.7 (nf_tables): can't initialize iptables table \`${tName}': Table does not exist`, exitCode: 1 };
      }
      tableName = tName as TableName;
      argsCopy.splice(tIdx, 2);
    }

    const table = this.tables.get(tableName)!;

    // Parse command
    if (argsCopy.length === 0) {
      return { output: this.showUsage(), exitCode: 2 };
    }

    const cmd = argsCopy[0];
    const cmdArgs = argsCopy.slice(1);

    switch (cmd) {
      case '-L': case '--list':
        return this.cmdList(table, cmdArgs);
      case '-S': case '--list-rules':
        return this.cmdListRules(table, cmdArgs);
      case '-F': case '--flush':
        return this.cmdFlush(table, cmdArgs);
      case '-P': case '--policy':
        return this.cmdPolicy(table, cmdArgs);
      case '-A': case '--append':
        return this.cmdAppend(table, cmdArgs);
      case '-D': case '--delete':
        return this.cmdDelete(table, cmdArgs);
      case '-I': case '--insert':
        return this.cmdInsert(table, cmdArgs);
      case '-R': case '--replace':
        return this.cmdReplace(table, cmdArgs);
      case '-C': case '--check':
        return this.cmdCheck(table, cmdArgs);
      case '-N': case '--new-chain':
        return this.cmdNewChain(table, cmdArgs);
      case '-X': case '--delete-chain':
        return this.cmdDeleteChain(table, cmdArgs);
      case '-E': case '--rename-chain':
        return this.cmdRenameChain(table, cmdArgs);
      case '-Z': case '--zero':
        return this.cmdZero(table, cmdArgs);
      default:
        return { output: `iptables v1.8.7 (nf_tables): unknown option "${cmd}"`, exitCode: 2 };
    }
  }

  // ─── iptables-save ────────────────────────────────────────────

  executeSave(): string {
    const lines: string[] = [];
    lines.push(`# Generated by iptables-save`);

    for (const [tableName, table] of this.tables) {
      // Only output tables that have non-default state
      const hasRules = Array.from(table.chains.values()).some(c => c.rules.length > 0);
      const hasNonDefaultPolicy = Array.from(table.chains.values()).some(c => c.policy !== null && c.policy !== 'ACCEPT');
      const hasCustomChains = Array.from(table.chains.values()).some(c => c.policy === null);

      if (!hasRules && !hasNonDefaultPolicy && !hasCustomChains && tableName !== 'filter') continue;

      lines.push(`*${tableName}`);

      // Chain declarations with counters
      for (const [chainName, chain] of table.chains) {
        if (chain.policy !== null) {
          lines.push(`:${chainName} ${chain.policy} [${chain.pkts}:${chain.bytes}]`);
        } else {
          lines.push(`:${chainName} - [${chain.pkts}:${chain.bytes}]`);
        }
      }

      // Rules
      for (const [chainName, chain] of table.chains) {
        for (const rule of chain.rules) {
          lines.push(this.formatRuleAsCommand('A', chainName, rule));
        }
      }

      lines.push('COMMIT');
    }

    return lines.join('\n');
  }

  // ─── iptables-restore ─────────────────────────────────────────

  executeRestore(input: string): { output: string; exitCode: number } {
    const lines = input.split('\n');
    let currentTable: IptablesTable | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      // Table declaration: *filter, *nat, etc.
      if (line.startsWith('*')) {
        const tableName = line.slice(1);
        if (!VALID_TABLES.has(tableName)) {
          return { output: `iptables-restore: line failed: ${line}`, exitCode: 1 };
        }
        currentTable = this.tables.get(tableName as TableName)!;
        // Flush all chains in this table
        for (const chain of currentTable.chains.values()) {
          chain.rules = [];
        }
        continue;
      }

      if (line === 'COMMIT') {
        currentTable = null;
        continue;
      }

      if (!currentTable) continue;

      // Chain declaration: :INPUT ACCEPT [0:0]
      if (line.startsWith(':')) {
        const match = line.match(/^:(\S+)\s+(\S+)\s+\[(\d+):(\d+)\]/);
        if (match) {
          const [, chainName, policy, pkts, bytes] = match;
          let chain = currentTable.chains.get(chainName);
          if (!chain) {
            chain = { name: chainName, policy: null, rules: [], pkts: 0, bytes: 0 };
            currentTable.chains.set(chainName, chain);
          }
          if (policy !== '-') {
            chain.policy = policy as BuiltinPolicy;
          }
          chain.pkts = parseInt(pkts);
          chain.bytes = parseInt(bytes);
        }
        continue;
      }

      // Rule: -A INPUT -p tcp --dport 22 -j ACCEPT
      if (line.startsWith('-A ')) {
        const ruleArgs = this.splitCommandLine(line.slice(3));
        const result = this.cmdAppend(currentTable, ruleArgs);
        if (result.exitCode !== 0) {
          return { output: `iptables-restore: line failed: ${line}`, exitCode: 1 };
        }
      }
    }

    return { output: '', exitCode: 0 };
  }

  // ─── -L (list) ────────────────────────────────────────────────

  private cmdList(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    let chainName = '';
    let numeric = false;
    let verbose = false;
    let lineNumbers = false;

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-n': case '--numeric': numeric = true; break;
        case '-v': case '--verbose': verbose = true; break;
        case '--line-numbers': lineNumbers = true; break;
        default:
          if (!args[i].startsWith('-')) chainName = args[i];
          break;
      }
    }

    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) {
        return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
      }
      return { output: this.formatChainList(chain, table, verbose, numeric, lineNumbers), exitCode: 0 };
    }

    // List all chains
    const lines: string[] = [];
    for (const chain of table.chains.values()) {
      if (lines.length > 0) lines.push('');
      lines.push(this.formatChainList(chain, table, verbose, numeric, lineNumbers));
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private formatChainList(chain: IptablesChain, table: IptablesTable, verbose: boolean, numeric: boolean, lineNumbers: boolean): string {
    const lines: string[] = [];

    // Chain header
    if (chain.policy !== null) {
      lines.push(`Chain ${chain.name} (policy ${chain.policy})`);
    } else {
      const refs = this.countChainReferences(chain.name, table);
      lines.push(`Chain ${chain.name} (${refs} references)`);
    }

    // Column headers
    if (verbose) {
      const numCol = lineNumbers ? 'num   ' : '';
      lines.push(`${numCol} pkts bytes target     prot opt in     out     source               destination`);
    } else {
      const numCol = lineNumbers ? 'num   ' : '';
      lines.push(`${numCol}target     prot opt source               destination`);
    }

    // Rules
    for (let i = 0; i < chain.rules.length; i++) {
      const rule = chain.rules[i];
      const numCol = lineNumbers ? `${i + 1}     `.slice(0, 6) : '';

      const target = rule.target.padEnd(10);
      const prot = (rule.negProtocol ? '!' : '') + (rule.protocol || 'all');
      const protStr = prot.padEnd(4);
      const opt = '--  ';
      const src = this.formatAddrForList(rule.source, rule.negSource, numeric);
      const dst = this.formatAddrForList(rule.destination, rule.negDestination, numeric);
      const extra = this.formatRuleExtrasForList(rule);

      if (verbose) {
        const pkts = String(rule.pkts).padStart(5);
        const bytes = String(rule.bytes).padStart(5);
        const inIf = (rule.negInInterface ? '!' : '') + (rule.inInterface || '*');
        const outIf = (rule.negOutInterface ? '!' : '') + (rule.outInterface || '*');
        lines.push(`${numCol}${pkts} ${bytes} ${target} ${protStr} ${opt}${inIf.padEnd(6)} ${outIf.padEnd(6)} ${src.padEnd(20)} ${dst}${extra}`);
      } else {
        lines.push(`${numCol}${target} ${protStr} ${opt}${src.padEnd(20)} ${dst}${extra}`);
      }
    }

    return lines.join('\n');
  }

  private formatAddrForList(addr: string, negated: boolean, numeric: boolean): string {
    const neg = negated ? '!' : '';
    if (!addr || addr === '0.0.0.0/0') {
      return numeric ? `${neg}0.0.0.0/0` : `${neg}anywhere`;
    }
    return `${neg}${addr}`;
  }

  private formatRuleExtrasForList(rule: IptablesRule): string {
    const parts: string[] = [];

    if (rule.dport) {
      parts.push(`${rule.protocol} dpt:${rule.dport}`);
    }
    if (rule.sport) {
      parts.push(`${rule.protocol} spt:${rule.sport}`);
    }

    for (const m of rule.matches) {
      for (const [opt, val] of m.options) {
        parts.push(`${opt.replace('--', '')}:${val}`);
      }
    }

    for (const [opt, val] of Object.entries(rule.targetOptions)) {
      parts.push(`${opt.replace('--', '')} ${val}`);
    }

    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  private countChainReferences(chainName: string, table: IptablesTable): number {
    let count = 0;
    for (const chain of table.chains.values()) {
      for (const rule of chain.rules) {
        if (rule.target === chainName) count++;
      }
    }
    return count;
  }

  // ─── -S (list rules as commands) ──────────────────────────────

  private cmdListRules(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    let chainName = '';
    for (const arg of args) {
      if (!arg.startsWith('-')) { chainName = arg; break; }
    }

    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) {
        return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
      }
      return { output: this.formatChainRules(chain), exitCode: 0 };
    }

    // All chains
    const lines: string[] = [];
    for (const chain of table.chains.values()) {
      lines.push(this.formatChainRules(chain));
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private formatChainRules(chain: IptablesChain): string {
    const lines: string[] = [];

    // Policy line for built-in chains
    if (chain.policy !== null) {
      lines.push(`-P ${chain.name} ${chain.policy}`);
    }

    // Rules
    for (const rule of chain.rules) {
      lines.push(this.formatRuleAsCommand('A', chain.name, rule));
    }

    return lines.join('\n');
  }

  private formatRuleAsCommand(action: string, chainName: string, rule: IptablesRule): string {
    const parts: string[] = [`-${action} ${chainName}`];

    // Source
    if (rule.source && rule.source !== '0.0.0.0/0') {
      if (rule.negSource) parts.push('!');
      parts.push(`-s ${rule.source}`);
    }

    // Destination
    if (rule.destination && rule.destination !== '0.0.0.0/0') {
      if (rule.negDestination) parts.push('!');
      parts.push(`-d ${rule.destination}`);
    }

    // In interface
    if (rule.inInterface) {
      if (rule.negInInterface) parts.push('!');
      parts.push(`-i ${rule.inInterface}`);
    }

    // Out interface
    if (rule.outInterface) {
      if (rule.negOutInterface) parts.push('!');
      parts.push(`-o ${rule.outInterface}`);
    }

    // Protocol
    if (rule.protocol && rule.protocol !== 'all') {
      if (rule.negProtocol) parts.push('!');
      parts.push(`-p ${rule.protocol}`);
    }

    // Ports
    if (rule.sport) {
      parts.push(`--sport ${rule.sport}`);
    }
    if (rule.dport) {
      parts.push(`--dport ${rule.dport}`);
    }

    // Match extensions
    for (const m of rule.matches) {
      parts.push(`-m ${m.module}`);
      for (const [opt, val] of m.options) {
        parts.push(`${opt} ${this.quoteIfNeeded(val)}`);
      }
    }

    // Target
    if (rule.target) {
      parts.push(`-j ${rule.target}`);

      // Target options
      for (const [opt, val] of Object.entries(rule.targetOptions)) {
        parts.push(`${opt} ${this.quoteIfNeeded(val)}`);
      }
    }

    return parts.join(' ');
  }

  // ─── -F (flush) ───────────────────────────────────────────────

  private cmdFlush(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const chainName = args.find(a => !a.startsWith('-'));

    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) {
        return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
      }
      chain.rules = [];
    } else {
      for (const chain of table.chains.values()) {
        chain.rules = [];
      }
    }

    return { output: '', exitCode: 0 };
  }

  // ─── -P (policy) ──────────────────────────────────────────────

  private cmdPolicy(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) {
      return { output: 'iptables v1.8.7 (nf_tables): -P requires a chain and a policy', exitCode: 2 };
    }

    const chainName = args[0];
    const policy = args[1];

    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    if (chain.policy === null) {
      return { output: `iptables: Can't set policy on user-defined chain \`${chainName}'`, exitCode: 1 };
    }

    if (policy !== 'ACCEPT' && policy !== 'DROP') {
      return { output: `iptables v1.8.7 (nf_tables): Bad policy name. Try ACCEPT or DROP.`, exitCode: 2 };
    }

    chain.policy = policy;
    return { output: '', exitCode: 0 };
  }

  // ─── -A (append) ──────────────────────────────────────────────

  private cmdAppend(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      return { output: 'iptables v1.8.7 (nf_tables): -A requires a chain name', exitCode: 2 };
    }

    const chainName = args[0];
    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    const rule = this.parseRule(args.slice(1));
    if (typeof rule === 'string') {
      return { output: rule, exitCode: 1 };
    }

    chain.rules.push(rule);
    return { output: '', exitCode: 0 };
  }

  // ─── -D (delete) ──────────────────────────────────────────────

  private cmdDelete(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) {
      return { output: 'iptables v1.8.7 (nf_tables): -D requires a chain and rule specification or number', exitCode: 2 };
    }

    const chainName = args[0];
    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    // Delete by number: iptables -D INPUT 1
    if (args.length === 2 && /^\d+$/.test(args[1])) {
      const num = parseInt(args[1]);
      if (num < 1 || num > chain.rules.length) {
        return { output: `iptables: Index of deletion too big.`, exitCode: 1 };
      }
      chain.rules.splice(num - 1, 1);
      return { output: '', exitCode: 0 };
    }

    // Delete by specification
    const ruleSpec = this.parseRule(args.slice(1));
    if (typeof ruleSpec === 'string') {
      return { output: ruleSpec, exitCode: 1 };
    }

    const idx = chain.rules.findIndex(r => this.rulesMatch(r, ruleSpec));
    if (idx === -1) {
      return { output: `iptables: Bad rule (does a matching rule exist in that chain?).`, exitCode: 1 };
    }

    chain.rules.splice(idx, 1);
    return { output: '', exitCode: 0 };
  }

  // ─── -I (insert) ──────────────────────────────────────────────

  private cmdInsert(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      return { output: 'iptables v1.8.7 (nf_tables): -I requires a chain name', exitCode: 2 };
    }

    const chainName = args[0];
    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    // Check if next arg is a number (position)
    let pos = 1;
    let ruleArgs: string[];
    if (args.length > 1 && /^\d+$/.test(args[1])) {
      pos = parseInt(args[1]);
      ruleArgs = args.slice(2);
    } else {
      ruleArgs = args.slice(1);
    }

    const rule = this.parseRule(ruleArgs);
    if (typeof rule === 'string') {
      return { output: rule, exitCode: 1 };
    }

    // Insert at position (1-indexed)
    const idx = Math.min(pos - 1, chain.rules.length);
    chain.rules.splice(idx, 0, rule);
    return { output: '', exitCode: 0 };
  }

  // ─── -R (replace) ─────────────────────────────────────────────

  private cmdReplace(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 3) {
      return { output: 'iptables v1.8.7 (nf_tables): -R requires a chain, rule number, and rule specification', exitCode: 2 };
    }

    const chainName = args[0];
    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    const num = parseInt(args[1]);
    if (isNaN(num) || num < 1 || num > chain.rules.length) {
      return { output: `iptables: Index of replacement too big.`, exitCode: 1 };
    }

    const rule = this.parseRule(args.slice(2));
    if (typeof rule === 'string') {
      return { output: rule, exitCode: 1 };
    }

    chain.rules[num - 1] = rule;
    return { output: '', exitCode: 0 };
  }

  // ─── -C (check) ───────────────────────────────────────────────

  private cmdCheck(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) {
      return { output: 'iptables v1.8.7 (nf_tables): -C requires a chain and rule specification', exitCode: 2 };
    }

    const chainName = args[0];
    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    const ruleSpec = this.parseRule(args.slice(1));
    if (typeof ruleSpec === 'string') {
      return { output: ruleSpec, exitCode: 1 };
    }

    const found = chain.rules.some(r => this.rulesMatch(r, ruleSpec));
    if (!found) {
      return { output: `iptables: Bad rule (does a matching rule exist in that chain?).`, exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  }

  // ─── -N (new chain) ───────────────────────────────────────────

  private cmdNewChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      return { output: 'iptables v1.8.7 (nf_tables): -N requires a chain name', exitCode: 2 };
    }

    const chainName = args[0];
    if (table.chains.has(chainName)) {
      return { output: `iptables: Chain already exists.`, exitCode: 1 };
    }

    table.chains.set(chainName, {
      name: chainName,
      policy: null,
      rules: [],
      pkts: 0,
      bytes: 0,
    });

    return { output: '', exitCode: 0 };
  }

  // ─── -X (delete chain) ────────────────────────────────────────

  private cmdDeleteChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length === 0) {
      // Delete all empty user-defined chains
      const toDelete: string[] = [];
      for (const [name, chain] of table.chains) {
        if (chain.policy === null && chain.rules.length === 0) {
          toDelete.push(name);
        }
      }
      for (const name of toDelete) {
        table.chains.delete(name);
      }
      return { output: '', exitCode: 0 };
    }

    const chainName = args[0];
    const chain = table.chains.get(chainName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    if (chain.policy !== null) {
      return { output: `iptables: Can't delete built-in chain \`${chainName}'`, exitCode: 1 };
    }

    if (chain.rules.length > 0) {
      return { output: `iptables: Directory not empty.`, exitCode: 1 };
    }

    table.chains.delete(chainName);
    return { output: '', exitCode: 0 };
  }

  // ─── -E (rename chain) ────────────────────────────────────────

  private cmdRenameChain(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    if (args.length < 2) {
      return { output: 'iptables v1.8.7 (nf_tables): -E requires old and new chain names', exitCode: 2 };
    }

    const oldName = args[0];
    const newName = args[1];

    const chain = table.chains.get(oldName);
    if (!chain) {
      return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
    }

    if (chain.policy !== null) {
      return { output: `iptables: Can't rename built-in chain.`, exitCode: 1 };
    }

    if (table.chains.has(newName)) {
      return { output: `iptables: File exists.`, exitCode: 1 };
    }

    table.chains.delete(oldName);
    chain.name = newName;
    table.chains.set(newName, chain);

    // Update references in rules
    for (const c of table.chains.values()) {
      for (const rule of c.rules) {
        if (rule.target === oldName) {
          rule.target = newName;
        }
      }
    }

    return { output: '', exitCode: 0 };
  }

  // ─── -Z (zero counters) ───────────────────────────────────────

  private cmdZero(table: IptablesTable, args: string[]): { output: string; exitCode: number } {
    const chainName = args.find(a => !a.startsWith('-'));

    if (chainName) {
      const chain = table.chains.get(chainName);
      if (!chain) {
        return { output: `iptables: No chain/target/match by that name.`, exitCode: 1 };
      }
      chain.pkts = 0;
      chain.bytes = 0;
      for (const rule of chain.rules) {
        rule.pkts = 0;
        rule.bytes = 0;
      }
    } else {
      for (const chain of table.chains.values()) {
        chain.pkts = 0;
        chain.bytes = 0;
        for (const rule of chain.rules) {
          rule.pkts = 0;
          rule.bytes = 0;
        }
      }
    }

    return { output: '', exitCode: 0 };
  }

  // ─── Rule parsing ─────────────────────────────────────────────

  private parseRule(args: string[]): IptablesRule | string {
    const rule: IptablesRule = {
      protocol: '',
      source: '',
      destination: '',
      inInterface: '',
      outInterface: '',
      sport: '',
      dport: '',
      target: '',
      targetOptions: {},
      matches: [],
      negSource: false,
      negDestination: false,
      negProtocol: false,
      negInInterface: false,
      negOutInterface: false,
      pkts: 0,
      bytes: 0,
    };

    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      // Check for negation
      const isNeg = arg === '!';
      if (isNeg) {
        i++;
        if (i >= args.length) break;
      }

      switch (args[i]) {
        case '-p': case '--protocol':
          i++;
          if (isNeg) rule.negProtocol = true;
          rule.protocol = args[i] || '';
          break;

        case '-s': case '--source':
          i++;
          if (isNeg) rule.negSource = true;
          rule.source = args[i] || '';
          break;

        case '-d': case '--destination':
          i++;
          if (isNeg) rule.negDestination = true;
          rule.destination = args[i] || '';
          break;

        case '-i': case '--in-interface':
          i++;
          if (isNeg) rule.negInInterface = true;
          rule.inInterface = args[i] || '';
          break;

        case '-o': case '--out-interface':
          i++;
          if (isNeg) rule.negOutInterface = true;
          rule.outInterface = args[i] || '';
          break;

        case '--sport': case '--source-port':
          i++;
          rule.sport = args[i] || '';
          break;

        case '--dport': case '--destination-port':
          i++;
          rule.dport = args[i] || '';
          break;

        case '-j': case '--jump':
          i++;
          rule.target = args[i] || '';
          // Parse target options (everything after target until next flag or end)
          i++;
          while (i < args.length && args[i].startsWith('--')) {
            const optName = args[i];
            i++;
            if (i < args.length && !args[i].startsWith('-') || (i < args.length && args[i].startsWith('--'))) {
              // Handle quoted values
              rule.targetOptions[optName] = args[i] || '';
              i++;
            } else {
              rule.targetOptions[optName] = '';
            }
          }
          continue; // Skip the i++ at end of loop

        case '-m': case '--match':
          i++;
          if (i >= args.length) break;
          const matchModule = args[i];
          const matchExt: IptablesMatchExtension = {
            module: matchModule,
            options: new Map(),
          };
          // Parse match options
          i++;
          while (i < args.length && args[i].startsWith('--')) {
            const optName = args[i];
            i++;
            if (i < args.length && !args[i].startsWith('-')) {
              matchExt.options.set(optName, args[i]);
              i++;
            } else {
              // Option without value
              matchExt.options.set(optName, '');
            }
          }
          rule.matches.push(matchExt);
          continue; // Skip the i++ at end of loop

        default:
          break;
      }

      i++;
    }

    return rule;
  }

  private rulesMatch(a: IptablesRule, b: IptablesRule): boolean {
    return a.protocol === b.protocol &&
      a.source === b.source &&
      a.destination === b.destination &&
      a.inInterface === b.inInterface &&
      a.outInterface === b.outInterface &&
      a.sport === b.sport &&
      a.dport === b.dport &&
      a.target === b.target &&
      a.negSource === b.negSource &&
      a.negDestination === b.negDestination &&
      a.negProtocol === b.negProtocol &&
      a.negInInterface === b.negInInterface &&
      a.negOutInterface === b.negOutInterface &&
      this.matchExtensionsEqual(a.matches, b.matches);
  }

  private matchExtensionsEqual(a: IptablesMatchExtension[], b: IptablesMatchExtension[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].module !== b[i].module) return false;
      if (a[i].options.size !== b[i].options.size) return false;
      for (const [key, val] of a[i].options) {
        if (b[i].options.get(key) !== val) return false;
      }
    }
    return true;
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private quoteIfNeeded(val: string): string {
    if (val.includes(' ') || val.includes(':') && val.includes(' ')) {
      return `"${val}"`;
    }
    return val;
  }

  private splitCommandLine(line: string): string[] {
    // Simple tokenizer that respects quotes
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === quoteChar) {
          inQuote = false;
        } else {
          current += ch;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ' ' || ch === '\t') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);

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
