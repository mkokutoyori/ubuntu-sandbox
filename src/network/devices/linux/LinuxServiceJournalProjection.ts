/**
 * LinuxServiceJournalProjection — reactive bridge from the service-lifecycle
 * event stream to the systemd journal.
 *
 * Real systemd writes a "Started …" / "Stopped …" / "Reloaded …" line to the
 * journal for every unit state change; `journalctl -u <unit>` shows them.
 * This projection reproduces that — it subscribes to the service-lifecycle
 * events `LinuxServiceManager` publishes and records the matching journal
 * line, attributed to the unit so the `-u` filter finds it.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxLogManager } from './LinuxLogManager';
import type {
  ServiceLifecyclePayload,
  ServiceMainExitedPayload,
  ServiceRestartScheduledPayload,
  ServiceStartLimitedPayload,
} from './events';

export class LinuxServiceJournalProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly logManager: LinuxLogManager,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.service.started', (e) => this.journal(e.payload, 'Started')),
      bus.subscribe('linux.service.stopped', (e) => this.journal(e.payload, 'Stopped')),
      bus.subscribe('linux.service.reloaded', (e) => this.journal(e.payload, 'Reloaded')),
      bus.subscribe('linux.service.restarted', (e) => this.journal(e.payload, 'Started')),
      bus.subscribe('linux.service.main-exited', (e) => this.journalMainExit(e.payload)),
      bus.subscribe('linux.service.restart-scheduled', (e) => this.journalRestart(e.payload)),
      bus.subscribe('linux.service.start-limited', (e) => this.journalStartLimit(e.payload)),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private journal(p: ServiceLifecyclePayload, verb: 'Started' | 'Stopped' | 'Reloaded'): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logSystemd(`${p.name}.service`, `${verb} ${p.name}.service.`);
  }

  private journalMainExit(p: ServiceMainExitedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const unit = `${p.name}.service`;
    if (p.signal !== undefined) {
      const short = p.signal.replace(/^SIG/, '');
      this.logManager.logSystemd(unit,
        `${unit}: Main process exited, code=killed, signal=${short}`);
      return;
    }
    const code = p.exitCode ?? 0;
    if (code === 0) {
      this.logManager.logSystemd(unit, `${unit}: Succeeded.`);
    } else {
      this.logManager.logSystemd(unit,
        `${unit}: Main process exited, code=exited, status=${code}/FAILURE`);
    }
  }

  private journalRestart(p: ServiceRestartScheduledPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const unit = `${p.name}.service`;
    this.logManager.logSystemd(unit,
      `${unit}: Scheduled restart job, restart counter is at ${p.counter}.`);
  }

  private journalStartLimit(p: ServiceStartLimitedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const unit = `${p.name}.service`;
    this.logManager.logSystemd(unit, `${unit}: Start request repeated too quickly.`);
    this.logManager.logSystemd(unit, `${unit}: Failed with result 'start-limit-hit'.`);
  }
}
