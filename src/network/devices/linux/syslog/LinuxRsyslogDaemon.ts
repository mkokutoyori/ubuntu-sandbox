import type { PortSpec } from '@/network/core/ports/PortNumber';
import type { ListenerIdentity } from '@/network/tcp/ListenerSocketSink';
import { ConfigLoader } from '@/network/rsyslog/engine/Loader';
import { RsyslogEngine } from '@/network/rsyslog/engine/Engine';
import { RS_RET, RSYSLOG_VERSION, formatLogEntry } from '@/network/rsyslog/engine/Log';
import type { InputSubmission, InputSubmitter } from '@/network/rsyslog/engine/Modules';
import { BuiltinModuleCatalog } from '@/network/rsyslog/modules/Catalog';
import type { ServiceSocketServer } from '../ports/ServiceSocketServer';
import type { LinuxRsyslogHost } from './LinuxRsyslogHost';

export const RSYSLOG_CONFIG_PATH = '/etc/rsyslog.conf';
export const RSYSLOG_MODULE_DIRECTORY = '/usr/lib/x86_64-linux-gnu/rsyslog';
export const RSYSLOG_BINARY_MODULES = ['imudp', 'imtcp', 'imuxsock', 'imklog', 'immark', 'impstats'] as const;

const LOG_SYSLOG_FACILITY = 5;
const LOG_INFO = 6;
const SIGTERM = 15;
const FATAL_CODES: ReadonlySet<number> = new Set([RS_RET.CONF_FILE_NOT_FOUND, RS_RET.NO_ACTIONS]);

export interface ConfigVerification {
  readonly lines: readonly string[];
  readonly hadErrors: boolean;
  readonly fatalCode: number | null;
  readonly abortOnUncleanConfig: boolean;
}

export const UNCLEAN_CONFIG_ABORT_TEXT = [
  'rsyslogd: global(AbortOnUncleanConfig="on") is set, and config is not clean.',
  'Check error log for details, fix errors and restart. As a last',
  'resort, you may want to use global(AbortOnUncleanConfig="off") ',
  'to permit a startup with a dirty config.',
].join('\n');

export function runFailedText(code: number): string {
  return `rsyslogd: run failed with error ${code} (see rsyslog.h or try https://www.rsyslog.com/e/${-code} to learn what that number means)`;
}

export type DaemonStartOutcome = { readonly started: true } | { readonly started: false; readonly lines: readonly string[]; readonly fatalCode: number };

export class LinuxRsyslogDaemon implements ServiceSocketServer {
  private engine: RsyslogEngine | null = null;
  private readonly holder: { engine: RsyslogEngine | null } = { engine: null };
  private readonly bound = new Set<string>();
  private lastDiagnostics: readonly string[] = [];

  constructor(
    private readonly host: LinuxRsyslogHost,
    private readonly pid: () => number,
    private readonly moduleFileExists: (path: string) => boolean,
  ) {}

  private load(path: string = RSYSLOG_CONFIG_PATH): { loader: ConfigLoader; config: ReturnType<ConfigLoader['loadFile']> } {
    const submitter: InputSubmitter = { submit: (info: InputSubmission) => this.holder.engine?.submit(info) };
    const catalog = new BuiltinModuleCatalog(RSYSLOG_MODULE_DIRECTORY, this.moduleFileExists);
    const loader = new ConfigLoader({ host: this.host, catalog, submitter });
    return { loader, config: loader.loadFile(path) };
  }

  verify(path: string = RSYSLOG_CONFIG_PATH): ConfigVerification {
    const { loader, config } = this.load(path);
    const fatal = loader.log.entries.find((entry) => entry.severity === 'error' && FATAL_CODES.has(entry.code));
    const strictInputs = config.settings.requireAllInputs && config.inputDeclarationFailed;
    return {
      lines: loader.log.lines(),
      hadErrors: loader.log.hadErrors(),
      fatalCode: fatal?.code ?? (strictInputs ? RS_RET.CONFIG_ERROR : null),
      abortOnUncleanConfig: config.settings.abortOnUncleanConfig,
    };
  }

  get isRunning(): boolean {
    return this.engine !== null && this.engine.isStarted;
  }

  diagnostics(): readonly string[] {
    return this.lastDiagnostics;
  }

  start(): DaemonStartOutcome {
    if (this.isRunning) return { started: true };
    const { loader, config } = this.load();
    const lines = loader.log.lines();
    this.lastDiagnostics = lines;
    const fatal = loader.log.entries.find((entry) => entry.severity === 'error' && FATAL_CODES.has(entry.code));
    if (fatal !== undefined) return { started: false, lines, fatalCode: fatal.code };
    const activation: string[] = [];
    let capturing = false;
    const engine = new RsyslogEngine(config, this.host, {
      onInternalMessage: (_severity, _code, text) => { if (capturing) activation.push(`rsyslogd: ${text}`); },
    });
    this.engine = engine;
    this.holder.engine = engine;
    const outcome = engine.start(() => {
      for (const entry of loader.log.entries) {
        const severity = entry.severity === 'error' ? 3 : entry.severity === 'warning' ? 4 : 6;
        engine.internal(severity, entry.code, formatLogEntry(entry.text, entry.code));
      }
      capturing = true;
    });
    if ('code' in outcome) {
      this.engine = null;
      this.holder.engine = null;
      this.host.dispose();
      this.bound.clear();
      return { started: false, lines: [...lines, ...activation], fatalCode: outcome.code };
    }
    engine.internal(LOG_INFO, RS_RET.NO_ERRCODE, this.statusText('start'), false, LOG_SYSLOG_FACILITY);
    return { started: true };
  }

  hup(): void {
    const engine = this.engine;
    if (engine === null || !engine.isStarted) return;
    engine.internal(LOG_INFO, RS_RET.NO_ERRCODE, this.statusText('rsyslogd was HUPed'), false, LOG_SYSLOG_FACILITY);
    engine.hup();
  }

  stop(signal: number = SIGTERM): void {
    const engine = this.engine;
    if (engine === null) return;
    if (engine.isStarted) engine.internal(LOG_INFO, RS_RET.NO_ERRCODE, this.statusText(`exiting on signal ${signal}.`), false, LOG_SYSLOG_FACILITY);
    engine.stop();
    this.engine = null;
    this.holder.engine = null;
    this.host.dispose();
    this.bound.clear();
  }

  private statusText(event: string): string {
    return `[origin software="rsyslogd" swVersion="${RSYSLOG_VERSION}" x-pid="${this.pid()}" x-info="https://www.rsyslog.com"] ${event}`;
  }

  listeningSockets(): Array<{ port: number; protocol: 'udp' | 'tcp' }> {
    return this.host.boundSockets();
  }

  open(spec: PortSpec, _identity?: ListenerIdentity): boolean {
    return this.isRunning && this.host.boundSockets().some((socket) => socket.port === spec.port && socket.protocol === (spec.protocol === 'tcp' ? 'tcp' : 'udp'));
  }

  close(_spec: PortSpec): void {}
}
