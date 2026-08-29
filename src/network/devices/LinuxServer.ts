/**
 * LinuxServer - Linux server (root profile + Oracle process API).
 *
 * Phase 3: all logic lives in `LinuxMachine`. `LinuxServer` is a thin
 * shell that provides the server profile to the parent constructor
 * and exposes the Oracle-specific pass-throughs (`registerProcess`,
 * `unregisterProcess`, `clearSystemProcesses`) used by
 * `OracleFilesystemSync` to keep the Linux process table in sync with
 * `STARTUP` / `SHUTDOWN` reactively.
 */

import { IPAddress, type DeviceType, type EthernetFrame, type IPv4Packet } from '../core/types';
import { LinuxMachine } from './LinuxMachine';
import { LINUX_SERVER_PROFILE } from './linux/LinuxProfile';
import { getOracleDatabase, createSQLPlusSession } from '@/terminal/commands/database';
import { handleLsnrctl, handleTnsping, handleAdrci, handleExpdp, handleImpdp } from '@/terminal/commands/OracleCommands';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';
import type { HostCapableDevice } from '@/network';
import { RadiusServerAgent } from '../radius/RadiusServerAgent';
import { RadiusTcpServer } from '../radius/RadiusTcpTransport';
import { RadiusClientAgent } from '../radius/RadiusClientAgent';
import { RadiusdService, CLIENTS_CONF_PATH, USERS_FILE_PATH } from './linux/freeradius/RadiusdService';
import type { LinuxCommandContext } from './linux/commands/LinuxCommandContext';
import type { OperationResult } from './linux/LinuxServiceManager';
import { SmtpServer, SMTP_PORT, SMTP_SUBMISSION_PORT, SMTP_SUBMISSION_TLS_PORT } from '../smtp/SmtpServer';
import { selfSignedSmtpCert } from '../smtp/starttls';

/** Dedicated UDP port for the `radtest` probe client's replies — see `radtestClient`'s doc comment. */
const RADTEST_SOURCE_PORT = 49999;

export class LinuxServer extends LinuxMachine {
  /** freeradius-equivalent: a Linux Server can host the RADIUS protocol server (PRD-RADIUS P8) — not just Cisco/Huawei routers. */
  private readonly radiusServer: RadiusServerAgent;
  /** RFC 6613 RADIUS/TCP counterpart, hosted the same way. */
  private readonly radiusTcpServer: RadiusTcpServer;
  /** clients.conf/users-driven config + systemctl start/stop/restart/reload control (PRD-RADIUS §2.2). */
  private readonly radiusd: RadiusdService;
  /** Backs the `radtest` CLI tool (freeradius-utils) — a one-shot probe client, not persistent NAS config. */
  private readonly radtestClient: RadiusClientAgent;
  /** MTA-to-MTA relay reception + local delivery (RFC 5321), port 25. */
  private readonly smtpServer: SmtpServer;
  /** Message submission (RFC 6409) — AUTH mandatory, same engine as port 25. */
  private readonly smtpSubmissionServer: SmtpServer;
  /** smtps (RFC 8314) — implicit TLS from the first byte, no STARTTLS. */
  private readonly smtpImplicitTlsServer: SmtpServer;

  constructor(
    type: DeviceType = 'linux-server',
    name: string = 'Server',
    x: number = 0,
    y: number = 0,
  ) {
    super(type, name, x, y, LINUX_SERVER_PROFILE);

    const radiusHost = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      resolveRoute: (ip: string) => {
        const addr = IPAddress.tryParse(ip);
        if (!addr) return null;
        const r = this.resolveRoute(addr);
        return r ? { iface: r.port.getName(), nextHopIp: r.nextHopIP.toString() } : null;
      },
      sendIpv4FrameArpAware: (outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress) =>
        this.sendIpv4FrameArpAware(outPortName, ipPkt, nextHopIP),
      sendUdpDatagram: (request: import('../layers/transport/UdpEgress').UdpSendRequest) =>
        this.sendUdpDatagram(request),
      sourceAddressFor: (destination: IPAddress) => this.sourceAddressFor(destination),
    };
    this.radiusServer = new RadiusServerAgent(radiusHost, () => this.getBus());
    this.radiusTcpServer = new RadiusTcpServer(radiusHost, () => this.getBus(), () => this.getTcpStack());
    this.radiusd = new RadiusdService(this, this.radiusServer, this.radiusTcpServer, {
      read: (path) => this.executor.vfs.readFile(path),
    });
    this.seedDefaultRadiusdConfig();
    this.executor.serviceMgr.registerConfigCheck('freeradius', () => this.radiusd.checkConfig());
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'freeradius') return;
      if (event === 'start') this.applyRadiusd(this.radiusd.start());
      else if (event === 'restart') this.applyRadiusd(this.radiusd.restart());
      else if (event === 'reload') this.applyRadiusd(this.radiusd.reload());
      else if (event === 'stop') this.radiusd.stop();
    });
    // freeradius is enabledByDefault, so LinuxServiceManager's
    // own constructor (which runs inside `super()`, before the listener just
    // above existed) already marked the unit 'active' without anyone having
    // reacted to it. Perform the real bind/config-load now to match —
    // mirrors how attachSshTcpListeners() bridges the identical ordering
    // gap for sshd — so `getRadiusServer()` keeps working exactly as it did
    // before this PRD item (default clients.conf/users, always reachable),
    // while `systemctl stop/restart/reload freeradius` now do something real.
    this.applyRadiusd(this.radiusd.start());

    this.radtestClient = new RadiusClientAgent(radiusHost, () => this.getBus());
    this.radtestClient.start();
    // A standalone client agent has no destination port of its own to be
    // dispatched to on this host's socket-table-based UDP model (unlike a
    // router, which inline-checks every packet regardless of port) — pin
    // it to one fixed, udpBind-registered port instead of the varying,
    // identifier-derived ephemeral port `transmit()` otherwise picks.
    this.radtestClient.setFixedSourcePort(RADTEST_SOURCE_PORT);
    this.udpBind(RADTEST_SOURCE_PORT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress) this.radtestClient.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, 'radtest');

    const smtpCert = selfSignedSmtpCert(`CN=${this.getHostname()}`);
    const smtpTls = { serverCert: smtpCert.cert, serverPrivateKey: smtpCert.keyPair.privateKey };
    const smtpConfig = { hostname: this.getHostname(), eventBus: this.getBus() };
    this.smtpServer = new SmtpServer(this.getTcpStack(), smtpConfig, SMTP_PORT, { tls: smtpTls });
    this.smtpSubmissionServer = new SmtpServer(this.getTcpStack(), smtpConfig, SMTP_SUBMISSION_PORT, { tls: smtpTls });
    this.smtpImplicitTlsServer = new SmtpServer(this.getTcpStack(), smtpConfig, SMTP_SUBMISSION_TLS_PORT, { tls: smtpTls, implicitTls: true });

    // Wire Oracle bootstrap so `sqlplus` from the bash interpreter
    // actually boots the instance (pmon/smon/lgwr appear in ps -ef).
    this.executor._oracleBootstrap = (args: string[], stdin?: string) => {
      const db = getOracleDatabase(this.id);
      const banner =
        'SQL*Plus: Release 19.0.0.0.0 - Production\n\n' +
        'Connected to:\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0\n';
      // SQL commands can arrive on the command line or piped on stdin
      // (`echo "SHUTDOWN ABORT;" | sqlplus / as sysdba`).
      const script = `${args.join(' ')}\n${stdin ?? ''}`;

      // SHUTDOWN [ABORT|IMMEDIATE|TRANSACTIONAL|NORMAL] — stop the
      // instance; OracleInstance.shutdown publishes background-process-
      // stopped, which clears ora_pmon/ora_smon from the process table.
      const shut = /\bSHUTDOWN\b\s*(ABORT|IMMEDIATE|TRANSACTIONAL|NORMAL)?/i.exec(script);
      if (shut) {
        const mode = (shut[1]?.toUpperCase() ?? 'NORMAL') as
          'NORMAL' | 'IMMEDIATE' | 'TRANSACTIONAL' | 'ABORT';
        const lines = db.instance.shutdown(mode);
        return `${banner}\nSQL> ${lines.join('\n')}\nSQL> Disconnected from Oracle Database 19c.`;
      }
      // STARTUP piped in re-opens a stopped instance.
      if (/\bSTARTUP\b/i.test(script) && db.instance.state === 'SHUTDOWN') {
        const lines = db.instance.startup();
        return `${banner}\nSQL> ${lines.join('\n')}\nSQL> Disconnected from Oracle Database 19c.`;
      }

      // Run piped/arg SQL through the real engine — for both
      // `user/pass@conn "SQL"` and `… | sqlplus / as sysdba` (used to
      // drop the SQL on the sysdba path and fake "1 row selected" on the
      // password path).
      const isSysdba = /^\s*\/\s+as\s+sysdba\s*$/i.test(args.join(' '));
      const connectArg = args.find(a => !a.startsWith('-') && (a.includes('/') || a.includes('@')));
      const sqlRe = /\b(select|insert|update|delete|merge|begin|exec|create|drop|alter|commit|rollback|truncate|grant|revoke)\b/i;
      const sqlSource = [
        ...args.filter(a => a !== connectArg && !a.startsWith('-') && sqlRe.test(a)),
        stdin ?? '',
      ].join('\n').trim();
      const connArgs = isSysdba ? ['/', 'as', 'sysdba'] : connectArg ? [connectArg] : null;
      if (sqlSource && connArgs && db.instance.state === 'OPEN') {
        const { session, loginOutput } = createSQLPlusSession(this.id, connArgs);
        if (loginOutput.some(l => /^ERROR|ORA-\d/.test(l))) return loginOutput.join('\n');
        const out: string[] = [];
        for (const raw of sqlSource.split(';')) {
          const stmt = raw.trim();
          if (stmt) out.push(...session.processLine(`${stmt};`).output);
        }
        session.disconnect();
        return out.join('\n');
      }
      if (args.length === 0 || isSysdba) {
        return `${banner}\nSQL> Disconnected from Oracle Database 19c.`;
      }
      return null;
    };
    // Both the interactive terminal and the programmatic shell path
    // (executeShellCommandSync / SSH / scripts) go through the same real
    // handlers so lsnrctl/tnsping never diverge.
    this.executor._oracleListener = (args: string[]) => {
      const lines: string[] = [];
      handleLsnrctl(this as unknown as HostCapableDevice, args, (text) => lines.push(text));
      return lines.join('\n');
    };
    this.executor._oracleTnsping = (args: string[]) => {
      const lines: string[] = [];
      handleTnsping(this as unknown as HostCapableDevice, args, (text) => lines.push(text));
      return lines.join('\n');
    };
    this.executor._oracleUtil = (cmd: string, args: string[]) => {
      const handler = cmd === 'expdp' ? handleExpdp
        : cmd === 'impdp' ? handleImpdp
        : cmd === 'adrci' ? handleAdrci : null;
      if (!handler) return null;
      const lines: string[] = [];
      handler(this as unknown as HostCapableDevice, args, (text) => lines.push(text));
      return lines.join('\n');
    };
    // `rman target / <<EOF … EOF` and `echo "BACKUP …;" | rman target /`
    // drive the real reactive RMAN engine, not a banner-only stub.
    this.executor._oracleRman = (args: string[], stdin?: string) => {
      const { subShell, banner } = ReactiveRmanSubShell.create(this, args);
      const out = [...banner];
      const script = (stdin ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of script) {
        const res = subShell.processLine(line);
        out.push(...res.output);
        if (res.exit) break;
      }
      subShell.dispose();
      return out.join('\n');
    };
  }

  /** Real freeradius ships a working-but-minimal default config (localhost-only client, no users) — so does this. */
  private seedDefaultRadiusdConfig(): void {
    const dir = CLIENTS_CONF_PATH.slice(0, CLIENTS_CONF_PATH.lastIndexOf('/'));
    if (!this.executor.vfs.exists(dir)) this.executor.vfs.mkdirp(dir, 0o755, 0, 0);
    if (!this.executor.vfs.exists(CLIENTS_CONF_PATH)) {
      this.executor.vfs.writeFile(
        CLIENTS_CONF_PATH,
        'client localhost {\n\tipaddr = 127.0.0.1\n\tsecret = testing123\n}\n',
        0, 0, 0o022,
      );
    }
    if (!this.executor.vfs.exists(USERS_FILE_PATH)) {
      this.executor.vfs.writeFile(USERS_FILE_PATH, '', 0, 0, 0o022);
    }
  }

  private applyRadiusd(result: OperationResult): void {
    if (!result.ok) {
      this.radiusd.stop();
      this.executor.serviceMgr.markFailed('freeradius', result.error ?? 'failed to start');
    }
  }

  protected override buildCommandContext(): LinuxCommandContext {
    return { ...super.buildCommandContext(), radtestClient: this.radtestClient };
  }

  getRadiusServer(): RadiusServerAgent { return this.radiusServer; }
  getRadiusTcpServer(): RadiusTcpServer { return this.radiusTcpServer; }
  getRadiusd(): RadiusdService { return this.radiusd; }

  getSmtpServer(): SmtpServer { return this.smtpServer; }
  getSmtpSubmissionServer(): SmtpServer { return this.smtpSubmissionServer; }
  getSmtpImplicitTlsServer(): SmtpServer { return this.smtpImplicitTlsServer; }

  enableSmtpService(): void {
    this.smtpServer.start();
    this.smtpSubmissionServer.start();
    this.smtpImplicitTlsServer.start();
  }

  /** Expose a background process in `ps` output (used by Oracle DBMS). */
  registerProcess(pid: number, user: string, command: string): void {
    this.executor.registerProcess(pid, user, command);
  }

  /** Reactive counterpart of registerProcess — removes one entry. */
  unregisterProcess(pid: number): void {
    this.executor.unregisterProcess(pid);
  }

  externalPidForOsPid(osPid: number): number | undefined {
    return this.executor.externalPidForOsPid(osPid);
  }

  osPidForExternalPid(externalPid: number): number | undefined {
    return this.executor.osPidForExternalPid(externalPid);
  }

  /** Clear all externally registered processes. */
  clearSystemProcesses(): void {
    this.executor.clearSystemProcesses();
  }
}
