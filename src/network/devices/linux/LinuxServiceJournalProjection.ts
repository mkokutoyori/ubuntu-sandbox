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
import type { ServiceLifecyclePayload } from './events';

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
}
