/**
 * ListenerControl — stateful TNS listener for one Oracle instance.
 *
 * Single source of truth for:
 *  - the listener lifecycle (start/stop, real start date and uptime);
 *  - dynamic service registration (LREG): the advertised status is
 *    derived from the LIVE instance state — READY only when the database
 *    is open, BLOCKED while it is starting (nomount/mount), and no
 *    service at all when the instance is down;
 *  - per-handler connection counters (established / refused), advanced
 *    by @connect_identifier connections — local bequeath connections
 *    (`sqlplus / as sysdba`) never touch the listener, as in real Oracle;
 *  - the lsnrctl transcript bodies (status / services), which used to be
 *    hand-copied in three places with hardcoded counters and uptime.
 */
import { ORACLE_CONFIG, TNS_ERRORS } from '../OracleConfig';
import type { InstanceState } from '../OracleInstance';

export type ListenerConnectOutcome = { ok: true } | { ok: false; error: string };

export class ListenerControl {
  private _running = false;
  private _startedAt: Date | null = null;
  private _established = 0;
  private _refused = 0;
  private _port = ORACLE_CONFIG.PORT;

  constructor(private readonly env: {
    sid: () => string;
    instanceState: () => InstanceState;
  }) {}

  get running(): boolean { return this._running; }
  get port(): number { return this._port; }
  setPort(p: number): void {
    if (Number.isFinite(p) && p > 0 && p < 65536) this._port = p;
  }
  get startedAt(): Date | null { return this._startedAt; }
  get established(): number { return this._established; }
  get refused(): number { return this._refused; }

  /** @returns false when the listener was already running (TNS-01106). */
  start(): boolean {
    if (this._running) return false;
    this._running = true;
    this._startedAt = new Date();
    return true;
  }

  /** @returns false when the listener was already stopped (TNS-12541). */
  stop(): boolean {
    if (!this._running) return false;
    this._running = false;
    this._startedAt = null;
    return true;
  }

  /** LREG dynamic-registration view, derived from the live instance.
   *  null means the instance is down: nothing is registered. */
  serviceStatus(): 'READY' | 'BLOCKED' | null {
    const state = this.env.instanceState();
    if (state === 'OPEN') return 'READY';
    if (state === 'NOMOUNT' || state === 'MOUNT') return 'BLOCKED';
    return null;
  }

  /**
   * One client connection attempt through this listener (@tns connects).
   * Outcomes mirror the real error ladder: no listener (ORA-12541),
   * unknown service (ORA-12514), instance blocking (ORA-12528).
   */
  attemptConnect(service: string): ListenerConnectOutcome {
    if (!this._running) {
      return { ok: false, error: 'ORA-12541: TNS:no listener' };
    }
    if (service.toUpperCase() !== this.env.sid().toUpperCase()) {
      this._refused++;
      return {
        ok: false,
        error: 'ORA-12514: TNS:listener does not currently know of service requested in connect descriptor',
      };
    }
    const status = this.serviceStatus();
    if (status === null) {
      this._refused++;
      return {
        ok: false,
        error: 'ORA-12514: TNS:listener does not currently know of service requested in connect descriptor',
      };
    }
    if (status === 'BLOCKED') {
      this._refused++;
      return {
        ok: false,
        error: 'ORA-12528: TNS:listener: all appropriate instances are blocking new connections',
      };
    }
    this._established++;
    return { ok: true };
  }

  /** Real "N days M hr. K min. S sec" uptime from the actual start date. */
  uptime(): string {
    const ms = this._startedAt ? Date.now() - this._startedAt.getTime() : 0;
    const sec = Math.floor(ms / 1000);
    const days = Math.floor(sec / 86400);
    const hr = Math.floor((sec % 86400) / 3600);
    const min = Math.floor((sec % 3600) / 60);
    return `${days} days ${hr} hr. ${min} min. ${sec % 60} sec`;
  }

  /** "STATUS of the LISTENER" block (no banner / Connecting-to line). */
  statusBody(): string[] {
    const ver = `${ORACLE_CONFIG.VERSION}.0.0.0`;
    const port = this._port;
    const sid = this.env.sid();
    return [
      'STATUS of the LISTENER',
      '------------------------',
      'Alias                     LISTENER',
      `Version                   TNSLSNR for Linux: Version ${ver} - Production`,
      `Start Date                ${this._startedAt!.toISOString().slice(0, 19).replace('T', ' ')}`,
      `Uptime                    ${this.uptime()}`,
      'Trace Level               off',
      'Security                  ON: Local OS Authentication',
      'SNMP                      OFF',
      `Listener Parameter File   ${ORACLE_CONFIG.HOME}/network/admin/listener.ora`,
      `Listener Log File         ${ORACLE_CONFIG.BASE}/diag/tnslsnr/${sid.toLowerCase()}/listener/alert/log.xml`,
      'Listening Endpoints Summary...',
      `  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${port})))`,
      ...this.servicesSummary(),
      'The command completed successfully',
    ];
  }

  /** "Services Summary..." block with the real handler counters. */
  servicesBody(): string[] {
    return [...this.servicesSummary(true), 'The command completed successfully'];
  }

  /** TNS error block shown by status/services when the listener is down. */
  notRunningBody(): string[] {
    return [
      TNS_ERRORS.TNS_12541,
      ` ${TNS_ERRORS.TNS_12560}`,
      `  ${TNS_ERRORS.TNS_00511}`,
    ];
  }

  private servicesSummary(withHandlers = false): string[] {
    const sid = this.env.sid();
    const status = this.serviceStatus();
    if (status === null) {
      return ['The listener supports no services'];
    }
    const out = [
      'Services Summary...',
      `Service "${sid}" has 1 instance(s).`,
      `  Instance "${sid}", status ${status}, has 1 handler(s) for this service...`,
    ];
    if (withHandlers) {
      out.push(
        '    Handler(s):',
        `      "DEDICATED" established:${this._established} refused:${this._refused} state:ready`,
        '         LOCAL SERVER',
      );
    }
    return out;
  }
}
