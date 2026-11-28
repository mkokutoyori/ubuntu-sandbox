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

import { IPAddress, IPv6Address, type DeviceType, type EthernetFrame, type IPv4Packet } from '../core/types';
import { LinuxMachine } from './LinuxMachine';
import { LINUX_SERVER_PROFILE } from './linux/LinuxProfile';
import { oracleSqlConnector } from '@/adapters/RadiusOracleSql';
import { createSQLPlusSession, getOracleDatabase, parseSqlPlusInvocation, runSqlPlusScript, serveOracleNetConnection } from '@/terminal/commands/database';
import { installOracleClientHooks } from './linux/oracleClientHooks';
import { handleLsnrctl, handleAdrci, handleExpdp, handleImpdp } from '@/terminal/commands/OracleCommands';
import { runDgmgrl } from '@/terminal/commands/DgmgrlCommands';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';
import { parseRmanInvocation } from '@/terminal/subshells/rman/RmanInvocation';
import type { RmanRun } from './linux/LinuxCommandExecutor';
import type { HostCapableDevice } from '@/network';
import { RadiusServerAgent } from '../radius/RadiusServerAgent';
import { RadiusTcpServer } from '../radius/RadiusTcpTransport';
import { RadiusClientAgent } from '../radius/RadiusClientAgent';
import { RadiusAccountingClient } from '../radius/RadiusAccountingClient';
import { CoaClient } from '../radius/CoaClient';
import { formatRadiusAttribute } from '../radius/attributeText';
import { RADIUS_PACKET_NAME } from '../radius/types';
import { RadiusdService, CLIENTS_CONF_PATH, USERS_FILE_PATH, RADIUSD_CONF_PATH } from './linux/freeradius/RadiusdService';
import { DEFAULT_RADIUSD_CONF, DEFAULT_PROXY_CONF, REALM_MODULE } from './linux/freeradius/DefaultRadiusdConf';
import { RADZAP_PATH, RADZAP_SCRIPT } from './linux/freeradius/DefaultRadzap';
import { DEFAULT_SITE, STATUS_SITE, CONTROL_SOCKET_SITE } from './linux/freeradius/DefaultSites';
import { DEFAULT_PREPROCESS_MODULE, DEFAULT_HINTS, DEFAULT_HUNTGROUPS } from './linux/freeradius/DefaultPreprocess';
import { DEFAULT_DETAIL_MODULE } from './linux/freeradius/DefaultDetailModule';
import type { LinuxCommandContext } from './linux/commands/LinuxCommandContext';
import type { OperationResult } from './linux/LinuxServiceManager';
import { reverseNameOf } from './linux/network/ReverseName';
import { SmtpServer, SMTP_PORT, SMTP_SUBMISSION_PORT, SMTP_SUBMISSION_TLS_PORT } from '../smtp/SmtpServer';
import { selfSignedSmtpCert, type TlsServerConfig } from '../smtp/starttls';
import { yieldWhenSliceIsSpent } from '@/events/CooperativeYield';

/** Dedicated UDP port for the `radtest` probe client's replies — see `radtestClient`'s doc comment. */
const RADTEST_SOURCE_PORT = 49999;
const RADCLIENT_ACCT_SOURCE_PORT = 49998;
const RADCLIENT_COA_SOURCE_PORT = 49997;
const RADIUS_UTILS_SOCKET = 'freeradius-utils';

const SMTPD_FIRST_PID = 3100;

export class LinuxServer extends LinuxMachine {
  /** freeradius-equivalent: a Linux Server can host the RADIUS protocol server (PRD-RADIUS P8) — not just Cisco/Huawei routers. */
  private readonly radiusServer: RadiusServerAgent;
  /** RFC 6613 RADIUS/TCP counterpart, hosted the same way. */
  private readonly radiusTcpServer: RadiusTcpServer;
  /** clients.conf/users-driven config + systemctl start/stop/restart/reload control (PRD-RADIUS §2.2). */
  private readonly radiusd: RadiusdService;
  /** Backs the `radtest` CLI tool (freeradius-utils) — a one-shot probe client, not persistent NAS config. */
  private readonly radtestClient: RadiusClientAgent;
  private readonly radacctClient: RadiusAccountingClient;
  private readonly coaClient: CoaClient;
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
      sendUdpDatagramTo: (destination: IPAddress | IPv6Address, destinationPort: number, sourcePort: number, payload: unknown, payloadBytes?: number) =>
        this.sendUdpDatagramTo(destination, destinationPort, sourcePort, payload, payloadBytes),
      sourceAddress6For: (destination: IPv6Address) => this.sourceAddress6For(destination),
      sendUdpDatagramFrom: (source: IPv6Address, destination: IPv6Address, destinationPort: number, sourcePort: number, payload: unknown, payloadBytes?: number) =>
        this.sendUdpDatagram6(destination, destinationPort, sourcePort, payload, payloadBytes, { sourceIp: source }),
      sourceAddressFor: (destination: IPAddress) => this.sourceAddressFor(destination),
    };
    this.radiusServer = new RadiusServerAgent(radiusHost, () => this.getBus());
    this.radiusTcpServer = new RadiusTcpServer(radiusHost, () => this.getBus(), () => this.getTcpStack(), this.radiusServer);
    this.radiusd = new RadiusdService(this, this.radiusServer, this.radiusTcpServer, {
      read: (path) => this.executor.vfs.readFile(path),
      append: (path, text, umask = 0o022) => { this.executor.vfs.writeFile(path, text, 0, 0, umask, true); },
      list: (path) => this.executor.vfs.listDirectory(path)?.map((entry) => entry.name) ?? null,
    }, undefined, undefined, { zone: () => this.executor.identity.timezone, nowMs: () => this.executor.simulatedDate().getTime(), groupsOf: (name: string) => this.executor.userMgr.getUserGroups(name).map((group) => group.name) });
    this.radiusd.setSqlConnector(oracleSqlConnector(this.id));
    this.seedDefaultRadiusdConfig();
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'postfix') return;
      if (event === 'stop') this.disableSmtpService();
      else this.enableSmtpService();
    });
    this.executor.serviceMgr.registerConfigCheck('freeradius', () => this.radiusd.checkConfig());
    this.executor.serviceMgr.onLifecycle((event, name) => {
      if (name !== 'freeradius') return;
      if (event === 'start') this.applyRadiusd(this.radiusd.start());
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
    this.radacctClient = new RadiusAccountingClient(radiusHost, () => this.getBus());
    this.radacctClient.start();
    this.coaClient = new CoaClient(radiusHost, () => this.getBus());
    this.coaClient.start();
    this.coaClient.setFixedSourcePort(RADCLIENT_COA_SOURCE_PORT);
    this.udpBind(RADCLIENT_COA_SOURCE_PORT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress || dgram.sourceIP instanceof IPv6Address) this.coaClient.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, RADIUS_UTILS_SOCKET);
    this.udpBind(RADCLIENT_ACCT_SOURCE_PORT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress || dgram.sourceIP instanceof IPv6Address) this.radacctClient.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, RADIUS_UTILS_SOCKET);
    // A standalone client agent has no destination port of its own to be
    // dispatched to on this host's socket-table-based UDP model (unlike a
    // router, which inline-checks every packet regardless of port) — pin
    // it to one fixed, udpBind-registered port instead of the varying,
    // identifier-derived ephemeral port `transmit()` otherwise picks.
    this.radtestClient.setFixedSourcePort(RADTEST_SOURCE_PORT);
    this.udpBind(RADTEST_SOURCE_PORT, (dgram) => {
      if (dgram.sourceIP instanceof IPAddress || dgram.sourceIP instanceof IPv6Address) this.radtestClient.handleUdp(dgram.inPort, dgram.sourceIP, dgram.udp);
    }, RADIUS_UTILS_SOCKET);

    const smtpSubject = `CN=${this.getHostname()}`;
    let smtpTlsConfig: TlsServerConfig | null = null;
    const smtpTls = (): TlsServerConfig => {
      if (smtpTlsConfig === null) {
        const smtpCert = selfSignedSmtpCert(smtpSubject);
        smtpTlsConfig = { serverCert: smtpCert.cert, serverPrivateKey: smtpCert.keyPair.privateKey };
      }
      return smtpTlsConfig;
    };
    const smtpConfig = { hostname: this.getHostname(), eventBus: this.getBus() };
    this.smtpServer = new SmtpServer(this.getTcpStack(), smtpConfig, SMTP_PORT, { tls: smtpTls });
    this.smtpSubmissionServer = new SmtpServer(this.getTcpStack(), smtpConfig, SMTP_SUBMISSION_PORT, { tls: smtpTls });
    this.smtpImplicitTlsServer = new SmtpServer(this.getTcpStack(), smtpConfig, SMTP_SUBMISSION_TLS_PORT, { tls: smtpTls, implicitTls: true });

    // Wire Oracle bootstrap so `sqlplus` from the bash interpreter
    // actually boots the instance (pmon/smon/lgwr appear in ps -ef).
    installOracleClientHooks(this as unknown as HostCapableDevice, this.id, this.executor);
    this.executor._oracleBootstrap = (args: string[], stdin?: string) => {
      const db = getOracleDatabase(this.id);
      const banner =
        'SQL*Plus: Release 19.0.0.0.0 - Production\n\n' +
        'Connected to:\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0\n';
      // SQL commands can arrive on the command line or piped on stdin
      // (`echo "SHUTDOWN ABORT;" | sqlplus / as sysdba`).
      const script = `${args.join(' ')}\n${stdin ?? ''}`;
      const invocation = parseSqlPlusInvocation(args, stdin);
      if ((invocation.sqlSource || invocation.startScript !== null) && invocation.connArgs) {
        return runSqlPlusScript(this.id, invocation.connArgs, invocation.sqlSource, invocation.startScript, this.executor.oracleCaller('sqlplus'));
      }

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
      const { connArgs, sqlSource, isSysdba, startScript } = parseSqlPlusInvocation(args, stdin);
      if ((sqlSource || startScript !== null) && connArgs && (db.instance.state === 'OPEN' || startScript !== null)) {
        return runSqlPlusScript(this.id, connArgs, sqlSource, startScript);
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
    this.executor._oracleUtil = (cmd: string, args: string[], stdin?: string) => {
      if (cmd === 'dgmgrl') return runDgmgrl(this as unknown as HostCapableDevice, args, stdin, this.executor.oracleCaller('dgmgrl'));
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
      const steps = this.rmanScriptSteps(args, stdin);
      let step = steps.next();
      while (!step.done) step = steps.next();
      return step.value;
    };
    this.executor._oracleRmanAsync = async (args: string[], stdin?: string) => {
      const steps = this.rmanScriptSteps(args, stdin);
      let step = steps.next();
      while (!step.done) {
        await yieldWhenSliceIsSpent();
        step = steps.next();
      }
      return step.value;
    };
  }

  protected override acceptTnsConnection(socket: Parameters<typeof serveOracleNetConnection>[1] & { close(): void }): void {
    if (!serveOracleNetConnection(this.id, socket)) socket.close();
  }

  private rmanBequeathDenial(args: string[]): RmanRun | null {
    const caller = this.executor.oracleCaller('rman');
    const targetIndex = args.findIndex((argument) => argument.toLowerCase() === 'target');
    const target = targetIndex === -1 ? undefined : args[targetIndex + 1];
    if (caller.isDbaGroup || (target !== undefined && target !== '/')) return null;
    const probe = createSQLPlusSession(this.id, ['/', 'as', 'sysdba'], caller);
    if (!probe.loginOutput.some((line) => /ORA-01031/.test(line))) {
      probe.session.disconnect();
      return null;
    }
    return {
      output: [
        'Recovery Manager: Release 19.0.0.0.0 - Production', '',
        'RMAN-00571: ===========================================================',
        'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
        'RMAN-00571: ===========================================================',
        'RMAN-00554: initialization of internal recovery manager package failed',
        'RMAN-04005: error from target database: ',
        'ORA-01031: insufficient privileges',
      ].join('\n'),
      exitCode: 1,
    };
  }

  private *rmanScriptSteps(args: string[], stdin?: string): Generator<void, RmanRun> {
    const invocation = parseRmanInvocation(args);
    const denied = this.rmanBequeathDenial(args);
    if (denied !== null) return denied;
    const vfs = this.executor.vfs;
    const cwd = this.executor.getCwd();
    let source = stdin ?? '';
    if (invocation.commandFile !== null) {
      const content = vfs.readFile(vfs.normalizePath(invocation.commandFile, cwd));
      if (content === null) {
        return { output: `cmdfile=${invocation.commandFile}: No such file or directory`, exitCode: 1 };
      }
      source = content;
    }
    const { subShell, banner } = ReactiveRmanSubShell.create(this, args);
    const out = [...banner];
    const script = source.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of script) {
      const res = subShell.processLine(line);
      for (const text of res.output) out.push(text);
      if (res.exit) break;
      yield;
    }
    subShell.dispose();
    const output = out.join('\n');
    const exitCode = /RMAN-\d|ORA-\d/.test(output) ? 1 : 0;
    if (invocation.logFile === null) return { output, exitCode };
    const user = this.executor.ctx();
    vfs.writeFile(vfs.normalizePath(invocation.logFile, cwd), `${output}\n`, user.uid, user.gid, user.umask, invocation.appendToLog);
    return { output: '', exitCode };
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
    const modulesDir = `${dir}/mods-enabled`;
    if (!this.executor.vfs.exists(modulesDir)) this.executor.vfs.mkdirp(modulesDir, 0o755, 0, 0);
    if (!this.executor.vfs.exists(`${modulesDir}/detail`)) {
      this.executor.vfs.writeFile(`${modulesDir}/detail`, DEFAULT_DETAIL_MODULE, 0, 0, 0o022);
    }
    if (!this.executor.vfs.exists(`${modulesDir}/preprocess`)) {
      this.executor.vfs.writeFile(`${modulesDir}/preprocess`, DEFAULT_PREPROCESS_MODULE, 0, 0, 0o022);
    }
    if (!this.executor.vfs.exists(`${modulesDir}/realm`)) {
      this.executor.vfs.writeFile(`${modulesDir}/realm`, REALM_MODULE, 0, 0, 0o022);
    }
    const preprocessDir = `${dir}/mods-config/preprocess`;
    if (!this.executor.vfs.exists(preprocessDir)) this.executor.vfs.mkdirp(preprocessDir, 0o755, 0, 0);
    if (!this.executor.vfs.exists(`${preprocessDir}/hints`)) this.executor.vfs.writeFile(`${preprocessDir}/hints`, DEFAULT_HINTS, 0, 0, 0o022);
    if (!this.executor.vfs.exists(`${preprocessDir}/huntgroups`)) this.executor.vfs.writeFile(`${preprocessDir}/huntgroups`, DEFAULT_HUNTGROUPS, 0, 0, 0o022);
    const available = `${dir}/sites-available`;
    const enabled = `${dir}/sites-enabled`;
    for (const folder of [available, enabled]) if (!this.executor.vfs.exists(folder)) this.executor.vfs.mkdirp(folder, 0o755, 0, 0);
    if (!this.executor.vfs.exists(`${available}/default`)) this.executor.vfs.writeFile(`${available}/default`, DEFAULT_SITE, 0, 0, 0o022);
    if (!this.executor.vfs.exists(`${available}/status`)) this.executor.vfs.writeFile(`${available}/status`, STATUS_SITE, 0, 0, 0o022);
    if (!this.executor.vfs.exists(`${available}/control-socket`)) this.executor.vfs.writeFile(`${available}/control-socket`, CONTROL_SOCKET_SITE, 0, 0, 0o022);
    if (!this.executor.vfs.exists(`${enabled}/default`)) this.executor.vfs.createSymlink(`${enabled}/default`, '../sites-available/default', 0, 0);
    if (!this.executor.vfs.exists(RADIUSD_CONF_PATH)) {
      this.executor.vfs.writeFile(RADIUSD_CONF_PATH, DEFAULT_RADIUSD_CONF, 0, 0, 0o022);
    }
    if (!this.executor.vfs.exists(RADZAP_PATH)) {
      this.executor.vfs.writeFile(RADZAP_PATH, RADZAP_SCRIPT, 0, 0, 0o022);
      this.executor.vfs.chmod(RADZAP_PATH, 0o755);
    }
    if (!this.executor.vfs.exists(`${dir}/proxy.conf`)) this.executor.vfs.writeFile(`${dir}/proxy.conf`, DEFAULT_PROXY_CONF, 0, 0, 0o022);
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

  protected override buildCommandContext(outputPiped = false, invokedAs?: string): LinuxCommandContext {
    return { ...super.buildCommandContext(outputPiped, invokedAs), radtestClient: this.radtestClient, radacctClient: this.radacctClient, coaClient: this.coaClient, radiusd: this.radiusd };
  }

  getRadiusServer(): RadiusServerAgent { return this.radiusServer; }
  getRadiusTcpServer(): RadiusTcpServer { return this.radiusTcpServer; }
  getRadiusd(): RadiusdService { return this.radiusd; }

  followRadiusDebug(sink: (line: string) => void): () => void {
    this.radiusServer.setPacketTrace((event) => {
      const prefix = `(${event.number})`;
      const name = RADIUS_PACKET_NAME[event.packet.code];
      sink(`${prefix} ${event.direction === 'received' ? 'Received' : 'Sent'} ${name} Id ${event.packet.identifier} from ${event.sourceIp}:${event.sourcePort} to ${event.destinationIp}:${event.destinationPort} length ${event.length}`);
      for (const attribute of event.packet.attributes) sink(`${prefix}   ${formatRadiusAttribute(attribute)}`);
      if (event.direction === 'sent') sink(`${prefix} Finished request`);
    });
    this.radiusServer.setDebugEmit((number, lines) => { for (const line of lines) sink(`(${number}) ${line}`); });
    return () => {
      this.radiusServer.setPacketTrace(null);
      this.radiusServer.setDebugEmit(null);
    };
  }

  getSmtpServer(): SmtpServer { return this.smtpServer; }
  getSmtpSubmissionServer(): SmtpServer { return this.smtpSubmissionServer; }
  getSmtpImplicitTlsServer(): SmtpServer { return this.smtpImplicitTlsServer; }

  enableSmtpService(): void {
    this.smtpServer.start();
    this.smtpSubmissionServer.start();
    this.smtpImplicitTlsServer.start();
    this.logSmtpConnections();
  }

  disableSmtpService(): void {
    this.smtpServer.stop();
    this.smtpSubmissionServer.stop();
    this.smtpImplicitTlsServer.stop();
  }

  private smtpConnectionLogging = false;
  private smtpdPid = SMTPD_FIRST_PID;

  private logSmtpConnections(): void {
    if (this.smtpConnectionLogging) return;
    this.smtpConnectionLogging = true;
    const peer = (remoteIp: string): string => `${reverseNameOf(this.executor.nss, remoteIp) ?? 'unknown'}[${remoteIp}]`;
    const bus = this.getBus();
    bus.subscribe('smtp.session.opened', (event) => {
      this.executor.logMgr.logAt('mail.info', 'postfix/smtpd', `connect from ${peer(event.payload.remoteIp)}`, this.smtpdPid++);
    });
    bus.subscribe('smtp.session.closed', (event) => {
      const { abort } = event.payload;
      if (abort !== undefined && !abort.transactionOpen) {
        this.executor.logMgr.logAt(
          'mail.info', 'postfix/smtpd',
          `NOQUEUE: ${abort.reason} after ${abort.where} from ${peer(event.payload.remoteIp)}`, this.smtpdPid++);
      }
      this.executor.logMgr.logAt(
        'mail.info', 'postfix/smtpd',
        `disconnect from ${peer(event.payload.remoteIp)}${event.payload.commandStats}`, this.smtpdPid++);
    });
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
