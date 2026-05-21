/**
 * WindowsPC - Windows workstation with cmd.exe terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * Delegates command execution to modular handlers under windows/.
 *
 * Architecture follows linux/LinuxPC.ts pattern:
 *   - WindowsFileSystem (VFS) in windows/WindowsFileSystem.ts
 *   - Network commands in Win*.ts modules (WinIpconfig, WinNetsh, etc.)
 *   - File commands in WinFileCommands.ts + WinDir.ts
 *   - WindowsPC orchestrates both via context objects
 *
 * PowerShell is implemented as a sub-shell (ISubShell) at the terminal
 * session level, not at the device level. This device only handles cmd.exe.
 */

import { EndHost, PingResult } from './EndHost';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import { WindowsSshServerContext } from '../protocols/ssh/server/WindowsSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
import type { WinFileCommandContext } from './windows/WinFileCommands';
import { WindowsFileSystem } from './windows/WindowsFileSystem';
import { WindowsShellSession } from './windows/shell/WindowsShellSession';
import { WindowsUserManager } from './windows/WindowsUserManager';
import { WindowsServiceManager } from './windows/WindowsServiceManager';
import { WindowsProcessManager } from './windows/WindowsProcessManager';
import { PSRegistryProvider } from './windows/PSRegistryProvider';
import { PSEventLogProvider } from './windows/PSEventLogProvider';
import { cmdHelp } from './windows/WinHelp';
import { cmdIpconfig } from './windows/WinIpconfig';
import { cmdNetsh } from './windows/WinNetsh';
import { cmdPing } from './windows/WinPing';
import { cmdArp } from './windows/WinArp';
import { cmdGetmac } from './windows/WinGetmac';
import { cmdTracert } from './windows/WinTracert';
import { cmdRoute } from './windows/WinRoute';
import { cmdWevtutil } from './windows/WinWevtutil';
import { cmdWhoami } from './windows/WinWhoami';
import { cmdNetUser, cmdNetLocalgroup } from './windows/WinNetUser';
import { cmdIcacls } from './windows/WinIcacls';
import { cmdTasklist as cmdTasklistDynamic } from './windows/WinTasklist';
import { cmdTaskkill } from './windows/WinTaskkill';
import { cmdSc } from './windows/WinSc';
import { cmdNetStart, cmdNetStop } from './windows/WinNetStart';
import { cmdNetUse } from './windows/WinNetUse';
import { cmdNetShare } from './windows/WinNetShare';
import { cmdPrint } from './windows/WinPrint';
import { executeNslookup } from './linux/LinuxDnsService';
import { cmdDir } from './windows/WinDir';
import {
  cmdCd, cmdMkdir, cmdRmdir, cmdType, cmdCopy, cmdMove,
  cmdRen, cmdDel, cmdTree, cmdSet, cmdTasklist, cmdNetstat,
  cmdAttrib, cmdFind, cmdFindstr, cmdWhere, cmdMore, cmdFc,
  cmdXcopy, cmdSort,
} from './windows/WinFileCommands';

/**
 * Parse a `findstr` filter from a piped command (`net user | findstr /i Full`).
 * Returns the active flags and the literal patterns. Multi-token patterns
 * separated by spaces are split into individual `OR` patterns to mirror real
 * `findstr` behaviour (use `/C:"..."` to force a single literal substring).
 */
function parseFindstrFilter(filter: string): { patterns: string[]; ignoreCase: boolean; invert: boolean; count: boolean } {
  const tokens = filter.split(/\s+/).slice(1);
  let ignoreCase = false;
  let invert = false;
  let count = false;
  let cLiteral: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.toLowerCase() === '/i') { ignoreCase = true; continue; }
    if (t.toLowerCase() === '/v') { invert = true; continue; }
    if (t.toLowerCase() === '/c')  { count = true; continue; }
    if (/^\/c:/i.test(t)) {
      cLiteral = t.slice(3).replace(/^"|"$/g, '');
      continue;
    }
    if (t.startsWith('"')) {
      let str = t.slice(1);
      while (i < tokens.length - 1 && !str.endsWith('"')) { i++; str += ' ' + tokens[i]; }
      if (str.endsWith('"')) str = str.slice(0, -1);
      positional.push(str);
      continue;
    }
    positional.push(t);
  }

  if (cLiteral !== null) return { patterns: [cLiteral], ignoreCase, invert, count };
  // Bareword multi-token form: each token is a separate literal (OR semantics).
  return { patterns: positional, ignoreCase, invert, count };
}

export class WindowsPC extends EndHost {
  protected readonly defaultTTL = 128;
  /** DHCP event log for Windows Event Viewer */
  private dhcpEventLog: string[] = [];
  /** Track synced DHCP events to avoid duplicates */
  private trackedEvents: Set<string> = new Set();
  /** Virtual file system */
  private fs: WindowsFileSystem;
  /** Current working directory */
  private cwd: string = 'C:\\Users\\User';
  /** Environment variables */
  private env: Map<string, string> = new Map();
  /** Exposes the env map so subshells (PS / cmd) share the same source.
   *  Reads are case-insensitive on Windows. */
  getEnvVars(): Map<string, string> { return this.env; }
  getEnvVar(name: string): string | undefined {
    const u = name.toUpperCase();
    for (const [k, v] of this.env) if (k.toUpperCase() === u) return v;
    return undefined;
  }
  /** Per-interface DNS configuration: portName → { servers, mode } */
  private dnsConfig: Map<string, { servers: string[]; mode: 'static' | 'dhcp' }> = new Map();
  /** DHCP client trace flag */
  private dhcpTraceEnabled: boolean = false;
  /** Primary DNS suffix (set via netsh dnsclient set global) */
  private dnsSuffix: string = '';
  /** User and group manager (access control / privileges) */
  private userMgr: WindowsUserManager;
  /** Service manager (service lifecycle, dependencies) */
  private svcMgr: WindowsServiceManager;
  /** Process manager (process table, PIDs, kill, tree) */
  private procMgr: WindowsProcessManager;

  // ── Per-device transitional state (Phase 4 relocation) ──────────────────
  // These maps + provider instances used to live as private fields on
  // PowerShellExecutor. Moving them to the device makes them visible to
  // any consumer (the interpreter, future Get-* cmdlets, the executor's
  // own handlers via shared references) without going through the
  // executor as the source of truth.
  /** Additional IP addresses (added via New-NetIPAddress). */
  readonly extraIPs: Map<string, { ifAlias: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; skipAsSource: boolean; gateway?: string; addressFamily: string }> = new Map();
  /** Extra routes (added via New-NetRoute). */
  readonly extraRoutes: Map<string, { ifAlias: string; nextHop: string; metric: number }> = new Map();
  /** Adapter overrides: status / display name. */
  readonly adapterOverrides: Map<string, { status?: string; displayName?: string }> = new Map();
  /** Dynamic firewall rules (added via New-NetFirewallRule). */
  readonly dynamicFirewallRules: Map<string, { name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }> = new Map();
  /** Network connection profiles: ifIndex → category. */
  readonly networkProfiles: Map<number, string> = new Map();
  /** VPN connections: lowercase name → details. */
  readonly vpnConnections: Map<string, { name: string; serverAddress: string; tunnelType: string; encryptionLevel: string; authMethod: string }> = new Map();
  /** In-memory registry hive (HKLM / HKCU). */
  readonly registry: PSRegistryProvider = new PSRegistryProvider();

  /**
   * Shared scheduled-task table. Both `schtasks` (cmd) and the Get/Register/
   * Unregister-ScheduledTask cmdlets read and write here so a task created
   * from one shell is visible from the other.
   */
  readonly scheduledTasks: Map<string, { taskName: string; taskPath: string; state: string }> = new Map([
    ['googleupdatetaskuser',           { taskName: 'GoogleUpdateTaskUser',            taskPath: '\\',                         state: 'Ready' }],
    ['onedrive standalone update task',{ taskName: 'OneDrive Standalone Update Task', taskPath: '\\',                         state: 'Ready' }],
    ['.net framework ngen v4.0.30319', { taskName: '.NET Framework NGEN v4.0.30319',  taskPath: '\\Microsoft\\Windows\\.NET', state: 'Ready' }],
    ['simtesttask',                    { taskName: 'SimTestTask',                     taskPath: '\\',                         state: 'Ready' }],
  ]);
  /** Event-log store. */
  readonly eventLog: PSEventLogProvider = new PSEventLogProvider();

  constructor(type: DeviceType = 'windows-pc', name: string = 'WindowsPC', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts();
    this.fs = new WindowsFileSystem(name);
    this.userMgr = new WindowsUserManager();
    this.svcMgr = new WindowsServiceManager();
    this.procMgr = new WindowsProcessManager();
    this.initEnv();
    this.initDefaultSockets();
  }

  private initDefaultSockets(): void {
    // OpenSSH Server — SFTP transport
    this.socketTable.bind('tcp', '0.0.0.0', 22, 1088, 'sshd.exe');
    // RDP — Remote Desktop Protocol (TermService)
    this.socketTable.bind('tcp', '0.0.0.0', 3389, 1096, 'svchost.exe');
    // SMB — file sharing / domain traffic (LanmanServer)
    this.socketTable.bind('tcp', '0.0.0.0', 445, 4, 'System');
    // NetBIOS Session Service (LanmanServer)
    this.socketTable.bind('tcp', '0.0.0.0', 139, 4, 'System');

    // Persist SSH server config + host key under C:\ProgramData\ssh\ on
    // first boot so OpenSSH-for-Windows files are visible from the shell.
    this.getSshServerContext();

    // TCP SSH server on port 22 — handles SSH auth + SFTP subsystem.
    this.listenTcp(22, (conn) => {
      this.getSshServerHandler().register(conn, '0.0.0.0');
    });
  }

  /** Build a fresh ISshServerContext bound to this machine's NTFS / users. */
  getSshServerContext(): WindowsSshServerContext {
    return new WindowsSshServerContext(this.fs, this.userMgr, this.hostname);
  }

  /** Build a SshServerHandler ready to be hooked onto a TcpConnection. */
  getSshServerHandler(): SshServerHandler {
    return new SshServerHandler(this.getSshServerContext());
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  private initEnv(): void {
    this.env.set('USERNAME', 'User');
    this.env.set('COMPUTERNAME', this.hostname);
    this.env.set('HOMEDRIVE', 'C:');
    this.env.set('HOMEPATH', '\\Users\\User');
    this.env.set('USERPROFILE', 'C:\\Users\\User');
    this.env.set('WINDIR', 'C:\\Windows');
    this.env.set('SYSTEMROOT', 'C:\\Windows');
    this.env.set('SYSTEMDRIVE', 'C:');
    this.env.set('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    this.env.set('PATH', 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem');
    this.env.set('PATHEXT', '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSH;.MSC');
    this.env.set('TEMP', 'C:\\Users\\User\\AppData\\Local\\Temp');
    this.env.set('TMP', 'C:\\Users\\User\\AppData\\Local\\Temp');
    this.env.set('OS', 'Windows_NT');
    this.env.set('PROCESSOR_ARCHITECTURE', 'AMD64');
    this.env.set('NUMBER_OF_PROCESSORS', '4');
  }

  private static readonly HOSTS_FILE = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

  /** Single source of truth for the simulated OS build, so `ver` reports
   *  the same string from cmd and from the PowerShell native shim, and it
   *  agrees with `systeminfo` (build 22631). */
  private static readonly VER_STRING = '\nMicrosoft Windows [Version 10.0.22631.6649]';

  // ─── Hosts file ──────────────────────────────────────────────

  addHostsEntry(ip: string, hostname: string): void {
    this.fs.appendFile(WindowsPC.HOSTS_FILE, `${ip}       ${hostname}\n`);
  }

  resolveHostname(name: string): IPAddress | null {
    try { return new IPAddress(name); } catch { /* not an IP */ }
    const result = this.fs.readFile(WindowsPC.HOSTS_FILE);
    if (result.ok && result.content) {
      for (const line of result.content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const parts = trimmed.split(/[\s\t]+/);
        if (parts.length >= 2) {
          const ip = parts[0];
          const hostnames = parts.slice(1).filter(h => !h.startsWith('#'));
          if (hostnames.some(h => h.toLowerCase() === name.toLowerCase())) {
            try { return new IPAddress(ip); } catch { /* skip invalid */ }
          }
        }
      }
    }
    return null;
  }

  // ─── Terminal ──────────────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    return this.executeCmdCommand(command);
  }

  /**
   * Execute a command in CMD mode.
   * Also used by PowerShellExecutor (via PSDeviceContext) to delegate
   * native commands (ipconfig, ping, cd, etc.) directly to cmd.
   */
  async executeCmdCommand(trimmed: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    trimmed = trimmed.trim();
    if (!trimmed) return '';

    // Strip stderr redirects like "2>&1", "2> nul", "2>nul" – in simulation all output is stdout
    trimmed = trimmed.replace(/\s+2>&1\s*$/i, '').replace(/\s+2>\s*(?:nul|&1)\s*$/i, '').trim();

    // Command chaining: `a && b` (b iff a ok), `a || b` (b iff a failed),
    // `a & b` (b always). Real cmd.exe semantics; needed so coherence
    // probes like `cd <dir> && cd` behave like the actual shell.
    const chain = this.splitCmdChain(trimmed);
    if (chain.length > 1) {
      const outputs: string[] = [];
      let prevFailed = false;
      for (const link of chain) {
        const run =
          link.op === '&'  ? true :
          link.op === '&&' ? !prevFailed :
          link.op === '||' ? prevFailed :
          true; // first segment (op === '')
        if (!run) continue;
        const out = await this.executeCmdCommand(link.cmd);
        if (out !== '') outputs.push(out);
        prevFailed = this.cmdOutputIsError(out);
      }
      return outputs.join('\n');
    }

    // Handle piped commands (but not inside redirects)
    if (trimmed.includes('|') && !trimmed.match(/[>]/)) {
      return this.executePipedCommand(trimmed);
    }

    // Handle echo with redirect: echo text > file / echo text >> file
    const redirectMatch = trimmed.match(/^(.+?)\s*(>>|>)\s*(.+)$/);
    if (redirectMatch) {
      return this.handleRedirect(redirectMatch[1].trim(), redirectMatch[2], redirectMatch[3].trim());
    }

    // Expand environment variables
    const expanded = this.expandEnvVars(trimmed);
    const parts = this.parseCommandLine(expanded);
    if (parts.length === 0) return '';

    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // File commands (use file context)
    const fileCtx = this.buildFileContext();
    switch (cmd) {
      case 'cd':
      case 'chdir':   return cmdCd(fileCtx, args);
      case 'dir':     return cmdDir(fileCtx, args);
      case 'mkdir':
      case 'md':      return cmdMkdir(fileCtx, args);
      case 'rmdir':
      case 'rd':      return cmdRmdir(fileCtx, args);
      case 'type':    return cmdType(fileCtx, args);
      case 'copy':    return cmdCopy(fileCtx, args);
      case 'move':    return cmdMove(fileCtx, args);
      case 'ren':
      case 'rename':  return cmdRen(fileCtx, args);
      case 'del':
      case 'erase':   return cmdDel(fileCtx, args);
      case 'tree':    return cmdTree(fileCtx, args);
      case 'set':     return cmdSet(fileCtx, args);
      case 'tasklist': return cmdTasklistDynamic(
        { processManager: this.procMgr, currentUser: this.userMgr.currentUser, hostname: this.hostname }, args);
      case 'taskkill': return cmdTaskkill(
        { processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() }, args);
      case 'sc':
      case 'sc.exe': return cmdSc(
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() }, args);
      case 'netstat': return cmdNetstat(fileCtx, args, this.socketTable);
      case 'attrib':  return cmdAttrib(fileCtx, args);
      case 'find':    return cmdFind(fileCtx, args);
      case 'findstr': return cmdFindstr(fileCtx, args);
      case 'where':   return cmdWhere(fileCtx, args);
      case 'more':    return cmdMore(fileCtx, args);
      case 'fc':      return cmdFc(fileCtx, args);
      case 'xcopy':   return cmdXcopy(fileCtx, args);
      case 'sort':    return cmdSort(fileCtx, args);
      case 'echo':    return args.join(' ');
      case 'cls':     return '';
      case 'ver':     return WindowsPC.VER_STRING;
      case 'hostname': return this.hostname;
      case 'systeminfo': return this.cmdSysteminfo();
      case 'whoami':  return cmdWhoami({ hostname: this.hostname, userManager: this.userMgr }, args);
      case 'icacls':  return cmdIcacls({ fs: this.fs, cwd: this.cwd, userManager: this.userMgr }, args);
      case 'runas':   return this.cmdRunas(args);
      case 'vol':     return this.cmdVol(args);
      case 'chcp':    return this.cmdChcp(args);
      case 'date':    return this.cmdDate(args);
      case 'time':    return this.cmdTime(args);
      case 'start':   return this.cmdStart(args);
      case 'setx':    return this.cmdSetx(args);
      case 'schtasks': return this.cmdSchtasks(args);
      case 'print':    return cmdPrint(this.buildNetContext(), args);
      case 'nbtstat': return this.cmdNbtstat(args);
      case 'wmic':    return this.cmdWmic(args);
      case 'reg':     return this.cmdReg(args);
    }

    // net user / net localgroup / net start / net stop / net help
    if (cmd === 'net') {
      if (args.length === 0) {
        return 'The syntax of this command is:\n\nNET\n    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]';
      }
      const subCmd = args[0].toLowerCase();
      const subArgs = args.slice(1);
      const netCtx2 = { hostname: this.hostname, userManager: this.userMgr };
      if (subCmd === 'user') return cmdNetUser(netCtx2, subArgs);
      if (subCmd === 'localgroup') return cmdNetLocalgroup(netCtx2, subArgs);
      const netSvcCtx = { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() };
      if (subCmd === 'start') return cmdNetStart(netSvcCtx, subArgs);
      if (subCmd === 'stop') return cmdNetStop(netSvcCtx, subArgs);
      if (subCmd === 'use') return cmdNetUse(this.buildNetContext(), subArgs);
      if (subCmd === 'share') return cmdNetShare(this.buildNetContext(), subArgs);
      if (subCmd === 'help' || subCmd === '/?' || subCmd === '-?') {
        const topic = (subArgs[0] ?? '').toLowerCase();
        if (!topic) {
          return 'The following commands are available:\n\nNET ACCOUNTS         NET HELPMSG       NET STATISTICS\nNET COMPUTER         NET LOCALGROUP    NET STOP\nNET CONFIG           NET PAUSE         NET TIME\nNET CONTINUE         NET SESSION       NET USE\nNET FILE             NET SHARE         NET USER\nNET GROUP            NET START         NET VIEW\nNET HELP             NET HELPMSG       NET HELP SERVICES';
        }
        return `The syntax of this command is:\n\nNET ${topic.toUpperCase()} [...]`;
      }
      return `The syntax of this command is:\n\nNET ${subCmd.toUpperCase()} [...]`;
    }

    // Network commands (use network context)
    const netCtx = this.buildNetContext();
    switch (cmd) {
      case 'help':     return cmdHelp(args);
      case 'ipconfig': return cmdIpconfig(netCtx, args);
      case 'netsh':    return cmdNetsh(netCtx, args);
      case 'ping':     return cmdPing(netCtx, args);
      case 'arp':      return cmdArp(netCtx, args);
      case 'getmac':   return cmdGetmac(netCtx, args);
      case 'tracert':
      case 'traceroute': return cmdTracert(netCtx, args);
      case 'route':    return cmdRoute(netCtx, args);
      case 'wevtutil': return cmdWevtutil(netCtx, args);
      case 'nslookup': return this.cmdNslookup(args);
      default:
        return `'${cmd}' is not recognized as an internal or external command,\noperable program or batch file.`;
    }
  }

  // ─── Command Chaining ─────────────────────────────────────────────

  /**
   * Split a command line into `&&` / `||` / `&`-separated links,
   * respecting double quotes. A single `|` is a PIPE (left intact for
   * the segment's own pipe handling); only `||` is a chain operator.
   */
  private splitCmdChain(line: string): Array<{ op: '' | '&&' | '||' | '&'; cmd: string }> {
    const links: Array<{ op: '' | '&&' | '||' | '&'; cmd: string }> = [];
    let buf = '';
    let inQuote = false;
    let pendingOp: '' | '&&' | '||' | '&' = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuote = !inQuote; buf += c; continue; }
      if (!inQuote) {
        if (c === '&' && line[i + 1] === '&') {
          links.push({ op: pendingOp, cmd: buf.trim() }); pendingOp = '&&'; buf = ''; i++; continue;
        }
        if (c === '|' && line[i + 1] === '|') {
          links.push({ op: pendingOp, cmd: buf.trim() }); pendingOp = '||'; buf = ''; i++; continue;
        }
        if (c === '&') {
          links.push({ op: pendingOp, cmd: buf.trim() }); pendingOp = '&'; buf = ''; continue;
        }
      }
      buf += c;
    }
    links.push({ op: pendingOp, cmd: buf.trim() });
    // Drop empty links (e.g. trailing `&`); keep at least one.
    const cleaned = links.filter(l => l.cmd.length > 0);
    return cleaned.length ? cleaned : [{ op: '', cmd: line.trim() }];
  }

  /** Heuristic: did a cmd produce an error (drives `&&` / `||`)? */
  private cmdOutputIsError(out: string): boolean {
    const s = out.trim().toLowerCase();
    if (!s) return false;
    return /^error:/.test(s)
      || s.includes('the system cannot find the path specified')
      || s.includes('the system cannot find the file specified')
      || s.includes('is not recognized as an internal or external command')
      || s.includes('access is denied')
      || s.includes('the syntax of the command is incorrect')
      || s.includes('the network path was not found')
      || s.includes('a duplicate name exists')
      || s.includes('the parameter is incorrect')
      || s.includes('the filename, directory name, or volume label syntax is incorrect')
      || s.includes('could not find')
      || s.includes('cannot find');
  }

  // ─── Command Parsing ──────────────────────────────────────────────

  private parseCommandLine(line: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ' ' && !inQuote) {
        if (current) { parts.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  private expandEnvVars(text: string): string {
    return text.replace(/%([^%]+)%/g, (match, varName) => {
      const upper = varName.toUpperCase();
      if (upper === 'CD') return this.cwd;
      return this.env.get(upper) ?? match;
    });
  }

  // ─── Redirect Handling ────────────────────────────────────────────

  private handleRedirect(cmdPart: string, op: string, filePath: string): string {
    // Execute the command part to get its output
    const expanded = this.expandEnvVars(cmdPart);
    const parts = this.parseCommandLine(expanded);
    if (parts.length === 0) return '';

    const cmd = parts[0].toLowerCase();
    let content: string;
    if (cmd === 'echo') {
      content = parts.slice(1).join(' ');
    } else {
      // For other commands, we'd need async, but echo is the main use case
      content = parts.slice(1).join(' ');
    }

    const absPath = this.fs.normalizePath(filePath, this.cwd);
    if (op === '>>') {
      this.fs.appendFile(absPath, content + '\n');
    } else {
      this.fs.createFile(absPath, content + '\n');
    }
    return '';
  }

  // ─── Piped Commands ─────────────────────────────────────────────

  private async executePipedCommand(command: string): Promise<string> {
    const segments = command.split('|').map(s => s.trim());
    let output = await this.executeCommand(segments[0]);

    for (let i = 1; i < segments.length; i++) {
      const filter = segments[i].trim();
      const filterParts = filter.split(/\s+/);
      const filterCmd = filterParts[0].toLowerCase();

      if (filterCmd === 'findstr') {
        const { patterns, ignoreCase, invert, count } = parseFindstrFilter(filter);
        const lines = output.split('\n');
        const matches = (line: string): boolean => {
          const haystack = ignoreCase ? line.toLowerCase() : line;
          return patterns.some(p => haystack.includes(ignoreCase ? p.toLowerCase() : p));
        };
        const filtered = lines.filter(l => invert ? !matches(l) : matches(l));
        output = count ? String(filtered.length) : filtered.join('\n');
      } else if (filterCmd === 'grep') {
        const pattern = filterParts[filterParts.length - 1];
        const lines = output.split('\n');
        output = lines.filter(l => l.includes(pattern)).join('\n');
      } else if (filterCmd === 'find') {
        const ci = /\s\/i(\s|$)/i.test(' ' + filter);
        const cnt = /\s\/c(\s|$)/i.test(' ' + filter);
        const quoteMatch = filter.match(/find\s+(?:\/[a-z]\s+)*"([^"]+)"/i);
        if (quoteMatch) {
          const pattern = quoteMatch[1];
          const lines = output.split('\n');
          const matched = lines.filter(l => ci ? l.toLowerCase().includes(pattern.toLowerCase()) : l.includes(pattern));
          output = cnt ? String(matched.length) : matched.join('\n');
        }
      } else if (filterCmd === 'more') {
        // Passthrough in simulation
      }
    }

    return output;
  }

  // ─── Tab Completion ──────────────────────────────────────────────

  getCompletions(partial: string): string[] {
    const parts = partial.trimStart().split(/\s+/);

    if (parts.length <= 1) {
      // Command completion
      const prefix = (parts[0] || '').toLowerCase();
      const commands = [
        'help', 'ipconfig', 'netsh', 'ping', 'arp', 'getmac', 'tracert', 'route',
        'wevtutil', 'hostname', 'ver', 'cls', 'systeminfo', 'tasklist',
        'netstat', 'dir', 'cd', 'mkdir', 'md', 'rmdir', 'rd', 'type',
        'copy', 'move', 'ren', 'rename', 'del', 'erase', 'echo', 'set',
        'tree', 'powershell', 'exit',
      ];
      return commands.filter(c => c.startsWith(prefix)).sort();
    }

    // File/directory completion for the last argument
    const lastArg = parts[parts.length - 1];
    // Split on last backslash to get directory and partial name
    const lastSep = lastArg.lastIndexOf('\\');
    let dir: string;
    let partialName: string;
    if (lastSep >= 0) {
      const dirPart = lastArg.substring(0, lastSep) || '\\';
      dir = this.fs.normalizePath(dirPart, this.cwd);
      partialName = lastArg.substring(lastSep + 1);
    } else {
      dir = this.cwd;
      partialName = lastArg;
    }

    return this.fs.getCompletions(dir, partialName);
  }

  // ─── Build Contexts ──────────────────────────────────────────────

  private buildFileContext(): WinFileCommandContext {
    return {
      fs: this.fs,
      cwd: this.cwd,
      hostname: this.hostname,
      env: this.env,
      setCwd: (path: string) => { this.cwd = path; },
    };
  }

  private buildNetContext(): WinCommandContext {
    return {
      hostname: this.hostname,
      ports: this.ports,
      defaultGateway: this.defaultGateway?.toString() || null,
      arpTable: this.arpTable,

      configureInterface: (ifName: string, ip: IPAddress, mask: SubnetMask) =>
        this.configureInterface(ifName, ip, mask),
      setDefaultGateway: (gw: IPAddress) => this.setDefaultGateway(gw),
      clearDefaultGateway: () => this.clearDefaultGateway(),
      addStaticRoute: (network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number) =>
        this.addStaticRoute(network, mask, nextHop, metric),
      removeRoute: (dest: IPAddress, mask: SubnetMask) => this.removeRoute(dest, mask),
      getRoutingTable: () => this.getRoutingTable() as RouteEntry[],

      isDHCPConfigured: (ifName: string) => this.isDHCPConfigured(ifName),
      getDHCPState: (ifName: string) => this.dhcpClient.getState(ifName),
      releaseLease: (ifName: string) => this.dhcpClient.releaseLease(ifName),
      requestLease: (ifName: string, opts: any) => this.dhcpClient.requestLease(ifName, opts),
      autoDiscoverDHCPServers: () => this.autoDiscoverDHCPServers(),

      addDHCPEvent: (type: string, message: string) => this.addDHCPEvent(type, message),
      syncDHCPEvents: () => this.syncDHCPEvents(),
      getDHCPEventLog: () => this.dhcpEventLog,

      executePingSequence: (target: IPAddress, count: number, timeout?: number, ttl?: number) =>
        this.executePingSequence(target, count, timeout, ttl),
      executeTraceroute: (target: IPAddress, maxHops?: number) =>
        this.executeTraceroute(target, maxHops) as Promise<TracerouteHop[]>,

      resetStack: () => {
        for (const [name, port] of this.ports) {
          port.clearIP();
          this.dhcpClient.releaseLease(name);
        }
        this.defaultGateway = null;
        this.routingTable = [];
        this.arpTable.clear();
        this.dnsConfig.clear();
        this.dnsSuffix = '';
      },

      // DNS management
      getDnsServers: (ifName: string) => {
        const cfg = this.dnsConfig.get(ifName);
        return cfg ? [...cfg.servers] : [];
      },
      setDnsServers: (ifName: string, servers: string[]) => {
        this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
      },
      getDnsMode: (ifName: string) => {
        return this.dnsConfig.get(ifName)?.mode ?? 'dhcp';
      },
      setDnsMode: (ifName: string, mode: 'static' | 'dhcp') => {
        if (mode === 'dhcp') {
          this.dnsConfig.set(ifName, { servers: [], mode: 'dhcp' });
        } else {
          const cfg = this.dnsConfig.get(ifName);
          if (cfg) cfg.mode = 'static';
          else this.dnsConfig.set(ifName, { servers: [], mode: 'static' });
        }
      },

      // Interface admin state
      setInterfaceAdmin: (ifName: string, enabled: boolean) => {
        const port = this.ports.get(ifName);
        if (port) port.setUp(enabled);
      },
      getInterfaceAdmin: (ifName: string) => {
        const port = this.ports.get(ifName);
        return port ? port.getIsUp() : false;
      },

      // IP address removal
      clearInterfaceIP: (ifName: string) => {
        const port = this.ports.get(ifName);
        if (port) port.clearIP();
      },

      // Switch interface to DHCP address mode
      setAddressDhcp: (ifName: string) => {
        const port = this.ports.get(ifName);
        if (port) port.clearIP();
        this.dhcpInterfaces.add(ifName);
      },

      // DHCP tracing
      getDhcpTraceEnabled: () => this.dhcpTraceEnabled,
      setDhcpTraceEnabled: (enabled: boolean) => { this.dhcpTraceEnabled = enabled; },

      // DNS suffix
      getDnsSuffix: () => this.dnsSuffix,
      setDnsSuffix: (suffix: string) => { this.dnsSuffix = suffix; },

      // ARP table mutation
      addStaticARP: (ip: string, mac: any, iface: string) => this.addStaticARP(ip, mac, iface),
      deleteARP: (ip: string) => this.deleteARP(ip),
      clearARPTable: () => this.clearARPTable(),

      // Interface renaming
      renameInterface: (oldName: string, newName: string): boolean => {
        const port = this.ports.get(oldName);
        if (!port || this.ports.has(newName)) return false;
        this.ports.delete(oldName);
        this.ports.set(newName, port);
        // Migrate DNS config
        const dns = this.dnsConfig.get(oldName);
        if (dns) { this.dnsConfig.delete(oldName); this.dnsConfig.set(newName, dns); }
        // Migrate DHCP state
        if (this.dhcpInterfaces.has(oldName)) { this.dhcpInterfaces.delete(oldName); this.dhcpInterfaces.add(newName); }
        return true;
      },

      // Hostname resolution
      resolveHostname: (name: string) => this.resolveHostname(name),

      // Service state query
      isServiceRunning: (name: string) => {
        const svc = this.svcMgr.getService(name);
        return svc ? svc.state === 'Running' : false;
      },
    };
  }

  // ─── DHCP Event Log ─────────────────────────────────────────────

  private syncDHCPEvents(): void {
    for (const [name] of this.ports) {
      const logs = this.dhcpClient.getLogs(name);
      if (!logs) continue;
      const logLines = logs.split('\n').filter(Boolean);
      for (const line of logLines) {
        const eventKey = `${name}:${line}`;
        if (!this.trackedEvents.has(eventKey)) {
          this.trackedEvents.add(eventKey);
          let type = 'INFO';
          if (line.includes('DHCPDISCOVER')) type = 'DISCOVER';
          else if (line.includes('DHCPOFFER')) type = 'OFFER';
          else if (line.includes('DHCPREQUEST')) type = 'REQUEST';
          else if (line.includes('DHCPACK')) type = 'ACK';
          else if (line.includes('DHCPNAK')) type = 'NAK';
          else if (line.includes('released')) type = 'RELEASE';
          else if (line.includes('RENEWING')) type = 'RENEW';
          else if (line.includes('INIT')) type = 'INIT';
          else if (line.includes('bound')) type = 'ACK';
          this.addDHCPEvent(type, `${line} on ${name}`);
        }
      }
    }
  }

  private addDHCPEvent(type: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.dhcpEventLog.push(`[${timestamp}] DHCP ${type}: ${message}`);
  }

  // ─── systeminfo ────────────────────────────────────────────────

  /**
   * Run a synchronous native CLI command (ipconfig / netsh / arp / route /
   * getmac / systeminfo / ver / net) directly. Used by the interpreter's
   * native-command cmdlets so they can deliver real output without going
   * through the async PowerShellExecutor pipeline.
   *
   * Returns null when the command is async (ping / tracert) or unknown —
   * callers fall back to executeCmdCommand() in that case.
   */
  runSyncNativeCommand(cmd: string, args: string[]): string | null {
    const lower = cmd.toLowerCase();
    if (lower === 'systeminfo') return this.cmdSysteminfo();
    if (lower === 'ver') return WindowsPC.VER_STRING;
    if (lower === 'hostname') return this.hostname;
    if (lower === 'vol')  return this.cmdVol(args);
    if (lower === 'chcp') return this.cmdChcp(args);
    if (lower === 'date') return this.cmdDate(args);
    if (lower === 'time') return this.cmdTime(args);
    if (lower === 'sc' || lower === 'sc.exe') {
      return cmdSc(
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() },
        args,
      );
    }
    // `net` is a multi-subcommand router — all its subhandlers are sync
    // (cmdNetUser / cmdNetLocalgroup / cmdNetStart / cmdNetStop).
    if (lower === 'net' && args.length > 0) {
      const subCmd = args[0].toLowerCase();
      const subArgs = args.slice(1);
      const netUserCtx = { hostname: this.hostname, userManager: this.userMgr };
      if (subCmd === 'user')        return cmdNetUser(netUserCtx, subArgs);
      if (subCmd === 'localgroup')  return cmdNetLocalgroup(netUserCtx, subArgs);
      const netSvcCtx = { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() };
      if (subCmd === 'start')       return cmdNetStart(netSvcCtx, subArgs);
      if (subCmd === 'stop')        return cmdNetStop(netSvcCtx, subArgs);
      if (subCmd === 'use')         return cmdNetUse(this.buildNetContext(), subArgs);
      if (subCmd === 'share')       return cmdNetShare(this.buildNetContext(), subArgs);
    }
    const netCtx = this.buildNetContext();
    switch (lower) {
      case 'ipconfig': return cmdIpconfig(netCtx, args);
      case 'netsh':    return cmdNetsh(netCtx, args);
      case 'arp':      return cmdArp(netCtx, args);
      case 'getmac':   return cmdGetmac(netCtx, args);
      case 'route':    return cmdRoute(netCtx, args);
      case 'nslookup': return this.cmdNslookup(args);
      // ping / tracert are async — no sync path.
      default: return null;
    }
  }

  private cmdSysteminfo(): string {
    const lines: string[] = [];
    lines.push(`Host Name:                 ${this.hostname}`);
    lines.push(`OS Name:                   Microsoft Windows 10 Pro`);
    lines.push(`OS Version:                10.0.22631 N/A Build 22631`);
    lines.push(`OS Manufacturer:           Microsoft Corporation`);
    lines.push(`OS Configuration:          Member Workstation`);
    lines.push(`OS Build Type:             Multiprocessor Free`);
    lines.push(`System Manufacturer:       ${this.hardware.manufacturer}`);
    lines.push(`System Model:              ${this.hardware.productName}`);
    lines.push(`System Type:               x64-based PC`);
    lines.push(...this.systeminfoHardwareLines());
    lines.push(`Network Card(s):           ${this.ports.size} NIC(s) Installed.`);
    let idx = 1;
    for (const [name, port] of this.ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      lines.push(`                           [${String(idx).padStart(2, '0')}]: Intel(R) Ethernet Connection`);
      const ip = port.getIPAddress();
      if (ip) {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 DHCP Enabled:    ${this.isDHCPConfigured(name) ? 'Yes' : 'No'}`);
        lines.push(`                                 IP address(es)`);
        lines.push(`                                 [01]: ${ip}`);
      } else {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 Status:          Media disconnected`);
      }
      idx++;
    }
    return lines.join('\n');
  }

  /**
   * The processor / BIOS / memory block of `systeminfo`, rendered from the
   * host's hardware inventory so it stays coherent with the device model.
   */
  private systeminfoHardwareLines(): string[] {
    const { cpu, memory, firmware } = this.hardware;
    const mb = (kib: number): string =>
      `${Math.round(kib / 1024).toLocaleString('en-US')} MB`;
    return [
      `Processor(s):              ${cpu.sockets} Processor(s) Installed.`,
      `                           [01]: Intel64 Family ${cpu.cpuFamily} ` +
        `Model ${cpu.model} Stepping ${cpu.stepping} ${cpu.vendor} ` +
        `~${cpu.clockMhz} Mhz`,
      `BIOS Version:              ${firmware.vendor} ${firmware.version}, ` +
        `${firmware.releaseDate}`,
      `Total Physical Memory:     ${mb(memory.totalKib)}`,
      `Available Physical Memory: ${mb(memory.availableKib)}`,
      `Virtual Memory: Max Size:  ${mb(memory.totalKib + memory.swapTotalKib)}`,
    ];
  }

  // ─── PSDeviceContext implementation ───────────────────────────

  getFileSystem(): WindowsFileSystem { return this.fs; }
  getPortsMap(): Map<string, Port> { return this.ports; }
  getCwd(): string { return this.cwd; }
  setCwd(path: string): void { this.cwd = path; }
  getDefaultGateway(): string | null { return this.defaultGateway?.toString() ?? null; }
  getDnsServers(ifName: string): string[] {
    const cfg = this.dnsConfig.get(ifName);
    return cfg ? [...cfg.servers] : [];
  }

  setDnsServers(ifName: string, servers: string[]): void {
    this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
  }

  /**
   * vol — print volume label + serial.  Real cmd output:
   *   Volume in drive C has no label.
   *   Volume Serial Number is XXXX-XXXX
   */
  private cmdVol(args: string[]): string {
    const arg = (args[0] ?? 'C:').toUpperCase().replace(/[:\\]+$/, '');
    const letter = arg.charAt(0) || 'C';
    // Single source of truth — same serial `dir` prints for this volume.
    const serial = this.fs.getVolumeSerialNumber(letter);
    return [
      ` Volume in drive ${letter} has no label.`,
      ` Volume Serial Number is ${serial}`,
    ].join('\n');
  }

  /** chcp — print/set active code page.  Defaults to 65001 (UTF-8). */
  private cmdChcp(args: string[]): string {
    if (args.length === 0) return 'Active code page: 65001';
    const cp = parseInt(args[0], 10);
    if (isNaN(cp)) return 'Invalid code page';
    return `Active code page: ${cp}`;
  }

  /** date /t — print today's date in MM/DD/YYYY (en-US). */
  private cmdDate(args: string[]): string {
    const wantOnly = args.includes('/t') || args.includes('/T');
    void wantOnly;
    const d = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = days[d.getDay()];
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dow} ${mm}/${dd}/${yyyy}`;
  }

  /** time /t — print current time in h:mm AM/PM (en-US). */
  private cmdTime(_args: string[]): string {
    const d = new Date();
    const h24 = d.getHours();
    const min = String(d.getMinutes()).padStart(2, '0');
    const tt = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${min} ${tt}`;
  }

  /** `start <program>` — simulator stub: returns silently (real cmd
   *  detaches a new process and returns immediately). */
  /**
   * `start <command>` — launch a program in a new session. Spawns into the
   * shared process manager so both `tasklist` and `Get-Process` see it.
   * Returns an empty string on success (matches cmd.exe semantics).
   */
  private cmdStart(args: string[]): string {
    // Strip cmd-style flags (/B, /WAIT, /MIN, ...) and the optional "title"
    // argument that precedes the executable.
    const filtered = args.filter(a => !a.startsWith('/'));
    if (filtered.length === 0) return '';
    let target = filtered[0].replace(/^["']|["']$/g, '');
    // `start "title" prog ...` form: drop the title token.
    if (filtered.length >= 2 && /^"[^"]*"$/.test(args.find(a => /^"[^"]*"$/.test(a)) ?? '')) {
      target = filtered[1].replace(/^["']|["']$/g, '');
    }
    if (!target) return '';
    const leaf = target.split(/[\\/]/).pop() ?? target;
    const imageName = /\.exe$/i.test(leaf) ? leaf : `${leaf}.exe`;
    const parent = this.procMgr.getAllProcesses().find(p => p.name.toLowerCase() === 'explorer.exe');
    const ppid = parent?.pid ?? 1;
    this.procMgr.spawnProcess(imageName, ppid, this.userMgr.currentUser, {
      session: 'Console', sessionId: 1,
    });
    return '';
  }

  /** `setx VAR VALUE [/M]` — persists an environment variable. */
  private cmdSetx(args: string[]): string {
    const machine = args.some(a => a.toUpperCase() === '/M');
    const filtered = args.filter(a => a.toUpperCase() !== '/M');
    if (filtered.length < 2) {
      return 'ERROR: Invalid syntax. Type "SETX /?" for usage.';
    }
    const name = filtered[0];
    const value = filtered.slice(1).join(' ').replace(/^"(.*)"$/, '$1');
    this.env.set(name, value);
    return machine
      ? `SUCCESS: Specified value was saved.`
      : `SUCCESS: Specified value was saved.`;
  }

  /**
   * `schtasks` — query/create/delete entries in the shared
   * `scheduledTasks` map so PowerShell's `Get-ScheduledTask` and
   * `Register-ScheduledTask` see the same data.
   */
  private cmdSchtasks(args: string[]): string {
    if (this.svcMgr.getService('Schedule')?.state !== 'Running') {
      return `ERROR: The Task Scheduler service is not running.`;
    }
    const action = args[0]?.toLowerCase();
    const flagIdx = (name: string) => args.findIndex(a => a.toLowerCase() === name);
    const tn      = (() => { const i = flagIdx('/tn'); return i >= 0 ? args[i + 1] : undefined; })();

    if (action === '/query') {
      const filtered = tn
        ? Array.from(this.scheduledTasks.values()).filter(t => t.taskName.toLowerCase() === tn.toLowerCase())
        : Array.from(this.scheduledTasks.values());
      const lines = [
        'Folder: \\',
        'TaskName                                 Next Run Time          Status',
        '======================================== ====================== ===============',
      ];
      for (const t of filtered) {
        lines.push(`${t.taskName.padEnd(40)} N/A                    ${t.state}`);
      }
      return lines.join('\n');
    }
    if (action === '/create') {
      if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
      this.scheduledTasks.set(tn.toLowerCase(), { taskName: tn, taskPath: '\\', state: 'Ready' });
      return `SUCCESS: The scheduled task "${tn}" has successfully been created.`;
    }
    if (action === '/delete') {
      if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
      const removed = this.scheduledTasks.delete(tn.toLowerCase());
      return removed
        ? `SUCCESS: The scheduled task "${tn}" was successfully deleted.`
        : `ERROR: The system cannot find the file specified.`;
    }
    if (action === '/run' || action === '/end' || action === '/change') {
      return 'SUCCESS: The scheduled task was created/modified successfully.';
    }
    return 'SCHTASKS /parameter [arguments]\n\nDescription:\n    Enables an administrator to create, delete, query, change, run, and\n    end scheduled tasks on a local or remote computer.';
  }

  /** `nbtstat -n / -a / -A` — returns a minimal local NetBIOS name table. */
  private cmdNbtstat(args: string[]): string {
    const flag = args[0]?.toLowerCase();
    if (flag === '-n') {
      return [
        '',
        '    Node IpAddress: [0.0.0.0] Scope Id: []',
        '',
        '                       NetBIOS Local Name Table',
        '',
        '       Name               Type         Status',
        '    ---------------------------------------------',
        `    ${this.hostname.toUpperCase().padEnd(16)} <00>  UNIQUE      Registered`,
        `    WORKGROUP        <00>  GROUP       Registered`,
        '',
      ].join('\n');
    }
    return 'NBTSTAT [ [-a RemoteName] [-A IP address] [-c] [-n] [-r] [-R] [-RR] [-s] [-S] [interval] ]';
  }

  /** `wmic logicaldisk get name` / minimal WMI stub. */
  private cmdWmic(args: string[]): string {
    if (args.length === 0) return 'wmic:root\\cli>';
    const joined = args.join(' ').toLowerCase();
    if (joined.includes('logicaldisk') && joined.includes('get name')) {
      return 'Name  \nC:    ';
    }
    if (joined.includes('os get caption')) {
      return 'Caption                              \nMicrosoft Windows 10 Enterprise      ';
    }
    if (joined.includes('cpu get name')) {
      return 'Name                                              \nIntel(R) Core(TM) i7 CPU @ 2.50GHz                ';
    }
    return '';
  }

  /** `reg query | add | delete` — bridges cmd.exe's reg.exe to the
   *  PowerShell registry provider so changes made from cmd are visible
   *  from `Get-ItemProperty HKCU:\…` in PS (and vice versa). */
  private cmdReg(args: string[]): string {
    if (args.length === 0) {
      return 'ERROR: Invalid syntax. Type "REG /?" for usage.';
    }
    const action = args[0].toLowerCase();
    const rawKey = args[1] ?? '';
    // `reg.exe` uses unprefixed HKCU\..., PS provider expects HKCU:\...
    const psKey = rawKey.replace(/^(HKCU|HKLM|HKCR|HKU|HKCC)\\/i, '$1:\\');
    if (action === 'query') {
      if (!this.registry.testPath(psKey)) {
        return 'ERROR: The system was unable to find the specified registry key or value.';
      }
      const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
      const recurse = args.some(a => a.toLowerCase() === '/s');
      const valueFilter = vIdx >= 0 ? args[vIdx + 1] : undefined;
      return this.formatRegQuery(rawKey, psKey, valueFilter, recurse);
    }
    if (action === 'add') {
      const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
      const tIdx = args.findIndex(a => a.toLowerCase() === '/t');
      const dIdx = args.findIndex(a => a.toLowerCase() === '/d');
      this.registry.newItem(psKey, true);
      if (vIdx >= 0) {
        const valueName = args[vIdx + 1];
        const data: string | number = dIdx >= 0
          ? args[dIdx + 1].replace(/^"(.*)"$/, '$1')
          : '';
        const typ = tIdx >= 0 ? args[tIdx + 1].toUpperCase() : 'REG_SZ';
        const coerced: string | number = typ === 'REG_DWORD' ? Number(data) : data;
        this.registry.setItemProperty(psKey, valueName, coerced);
      }
      return 'The operation completed successfully.';
    }
    if (action === 'delete') {
      const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
      if (vIdx >= 0) {
        this.registry.removeItemProperty(psKey, args[vIdx + 1]);
      } else {
        this.registry.removeItem(psKey, true);
      }
      return 'The operation completed successfully.';
    }
    return 'ERROR: Invalid syntax.';
  }

  /**
   * Render a `reg query` result in the canonical reg.exe layout:
   *   <RootKey>\<Sub>\<Sub>
   *       Name    REG_TYPE    Value
   * Optionally filters to a single value (`/v Name`) or recurses (`/s`).
   */
  private formatRegQuery(rawKey: string, psKey: string, valueFilter: string | undefined, recurse: boolean): string {
    const lines: string[] = [];
    const visit = (currentRaw: string, currentPs: string): void => {
      const values = this.registry.getItemPropertyValues(currentPs);
      const subkeys = this.registry.listSubkeyNames(currentPs);
      lines.push('');
      lines.push(currentRaw);
      if (values) {
        for (const [name, val] of Object.entries(values)) {
          if (valueFilter && name.toLowerCase() !== valueFilter.toLowerCase()) continue;
          const t = typeof val === 'number' ? 'REG_DWORD' : 'REG_SZ';
          const v = typeof val === 'number' ? `0x${val.toString(16)}` : String(val);
          lines.push(`    ${name}    ${t}    ${v}`);
        }
      }
      if (recurse) {
        for (const sub of subkeys) {
          visit(`${currentRaw}\\${sub}`, `${currentPs}\\${sub}`);
        }
      }
    };
    visit(rawKey, psKey);
    lines.push('');
    return lines.join('\n');
  }

  /** nslookup command implementation for Windows */
  private cmdNslookup(args: string[]): string {
    if (this.svcMgr.getService('Dnscache')?.state !== 'Running') {
      const host = args.find(a => !a.startsWith('-')) ?? '';
      return `*** Can't find ${host}: No DNS servers available\n` +
             `The DNS Client (Dnscache) service is not running.`;
    }
    // Get DNS server from any configured interface
    let resolverIP = '';
    for (const [ifName] of this.ports) {
      const servers = this.getDnsServers(ifName);
      if (servers.length > 0) { resolverIP = servers[0]; break; }
    }
    // Allow specifying server as second argument: nslookup domain server
    return executeNslookup(args, resolverIP);
  }

  // ─── User / Access Control ──────────────────────────────────────

  /** Switch current user context (for testing & runas) */
  setCurrentUser(name: string): void {
    if (this.userMgr.setCurrentUser(name)) {
      this.env.set('USERNAME', this.userMgr.currentUser);
      this.env.set('USERPROFILE', `C:\\Users\\${this.userMgr.currentUser}`);
      this.env.set('HOMEPATH', `\\Users\\${this.userMgr.currentUser}`);
    }
  }

  /** Get the user manager (for PowerShellExecutor and other integrations) */
  getUserManager(): WindowsUserManager { return this.userMgr; }

  /** Get the service manager (for PowerShellExecutor and other integrations) */
  getServiceManager(): WindowsServiceManager { return this.svcMgr; }

  /** Get the process manager (for PowerShellExecutor and other integrations) */
  getProcessManager(): WindowsProcessManager { return this.procMgr; }

  /** runas command — simplified non-interactive version */
  private cmdRunas(args: string[]): string {
    if (args.length === 0) {
      return 'RUNAS USAGE:\n\nRUNAS /user:<UserName> program';
    }

    let userName = '';
    const cmdParts: string[] = [];

    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower.startsWith('/user:')) {
        userName = arg.substring(6);
      } else {
        cmdParts.push(arg);
      }
    }

    if (!userName) {
      return 'RUNAS USAGE:\n\nRUNAS /user:<UserName> program';
    }

    const user = this.userMgr.getUser(userName);
    if (!user) {
      return `RUNAS ERROR: The user name "${userName}" is not recognized.`;
    }

    if (!user.enabled) {
      return `RUNAS ERROR: The account "${userName}" is disabled.`;
    }

    if (cmdParts.length === 0) {
      return 'RUNAS ERROR: No command specified.';
    }

    // Switch context, run command, (in simulation, stay switched)
    const prevUser = this.userMgr.currentUser;
    this.setCurrentUser(user.name);
    // For simulation, just execute the command as the new user
    // and return the result (user stays switched for simplicity)
    return this.executeCmdCommand(cmdParts.join(' ')) as unknown as string;
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'windows'; }

  // ─── Shell sessions (per-terminal isolation, §6 of terminal_gap.md) ─

  /** Live shell sessions keyed by their internal id. */
  private readonly shellSessions = new Map<string, WindowsShellSession>();
  /**
   * Per-device queue serialising concurrent executeCommandInSession calls.
   * Without it, two terminals issuing `cd` at the same time would race on
   * the device's mutable `cwd`/`env` swap window.
   */
  private wsExecQueue: Promise<unknown> = Promise.resolve();

  /**
   * Allocate a fresh cmd.exe shell session — one per terminal window.
   * Initial cwd = `%USERPROFILE%`, env is the device's seed env (copied,
   * so the session may freely mutate via `set FOO=bar` without leaking).
   */
  openShellSession(init?: { user?: string; cwd?: string; env?: Map<string, string> }): WindowsShellSession {
    const user = init?.user ?? (this.env.get('USERNAME') ?? 'User');
    const profile = this.env.get('USERPROFILE') ?? 'C:\\Users\\User';
    const env = new Map(init?.env ?? this.env);
    const session = new WindowsShellSession({
      user,
      cwd: init?.cwd ?? profile,
      env,
      comSpec: env.get('COMSPEC') ?? env.get('ComSpec'),
    });
    this.shellSessions.set(session.id, session);
    return session;
  }

  /** Tear down a shell session — the cmd.exe instance is reclaimed. */
  closeShellSession(sessionOrId: WindowsShellSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    const s = this.shellSessions.get(id);
    if (!s) return;
    s.dispose();
    this.shellSessions.delete(id);
  }

  /** Lookup helper for the terminal layer / tests. */
  getShellSession(id: string): WindowsShellSession | undefined {
    return this.shellSessions.get(id);
  }

  /**
   * Like `executeCommand`, but uses the per-terminal session as the swap-in
   * state holder. Calls are serialised per device so the mutation window
   * around `this.cwd` / `this.env` is never observed concurrently from
   * another terminal.
   */
  executeCommandInSession(command: string, session: WindowsShellSession): Promise<string> {
    const run = async () => {
      if (!this.isPoweredOn) return 'Device is powered off';
      if (session.disposed) return '';
      const baseline = this.snapshotShellState();
      this.swapInWindowsSession(session);
      try {
        const out = await this.executeCommand(command);
        this.captureShellStateInto(session);
        return out;
      } finally {
        this.restoreShellState(baseline);
      }
    };
    const promise = this.wsExecQueue.then(run, run) as Promise<string>;
    this.wsExecQueue = promise.catch(() => undefined);
    return promise;
  }

  /** Tab completion against a specific shell session's cwd/env. */
  getCompletionsForSession(partial: string, session: WindowsShellSession): string[] {
    if (session.disposed || !this.isPoweredOn) return [];
    const baseline = this.snapshotShellState();
    this.swapInWindowsSession(session);
    try {
      return this.getCompletions(partial);
    } finally {
      this.restoreShellState(baseline);
    }
  }

  private snapshotShellState() {
    return { cwd: this.cwd, env: new Map(this.env) };
  }

  private swapInWindowsSession(s: WindowsShellSession): void {
    this.cwd = s.cwd;
    // The device env carries seed values (USERPROFILE, ComSpec, …) that
    // sub-shells consume; we don't want a session to lose them when its
    // own env doesn't define them. Merge: device defaults first, session
    // overrides on top, so user `set FOO=bar` wins but builtins survive.
    const merged = new Map<string, string>();
    for (const [k, v] of this.env) merged.set(k, v);
    for (const [k, v] of s.env) merged.set(k, v);
    this.env = merged;
  }

  private captureShellStateInto(s: WindowsShellSession): void {
    s.cwd = this.cwd;
    // Capture only the keys that the session actually owned plus any
    // newly-defined ones. Keys unchanged from the device defaults stay
    // on the device — we don't want every session to drift its own copy
    // of USERPROFILE.
    const next = new Map<string, string>();
    for (const [k, v] of this.env) {
      if (!s.env.has(k)) {
        // Newly-defined or never-owned: belongs to the session iff it
        // differs from the baseline (captured below). We can't compute
        // that here cheaply, so we err on the safe side and store it.
        next.set(k, v);
      } else if (s.env.get(k) !== v) {
        next.set(k, v);
      } else {
        next.set(k, v);
      }
    }
    s.env = next;
    // Track drive cwd map for future `cd /d` support.
    const drive = this.cwd.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    if (drive) s.driveCwd.set(drive, this.cwd);
  }

  private restoreShellState(b: { cwd: string; env: Map<string, string> }): void {
    this.cwd = b.cwd;
    this.env = b.env;
  }
}
