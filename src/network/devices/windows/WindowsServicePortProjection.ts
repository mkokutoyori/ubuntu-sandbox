/**
 * WindowsServicePortProjection — reactive socket-table coherence for Windows
 * services.
 *
 * `WindowsServiceManager` no longer touches the socket table itself: it
 * announces every start/stop on the bus. This projection subscribes to that
 * stream and binds / releases the service's listening ports on the kernel
 * {@link SocketTable}, so stopping a service with `sc`/`net stop` removes
 * its ports from `netstat` and starting it puts them back.
 *
 * Windows analogue of the Linux {@link ServicePortProjection}.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SocketTable } from '../../core/SocketTable';
import type { WindowsServiceEventPayload } from './events';
import { WINDOWS_SERVICE_LISTENERS } from './WindowsServiceManager';

/** Default bind address when a listener spec does not pin one. */
const ALL_INTERFACES = '0.0.0.0';

export class WindowsServicePortProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly deviceId: string,
    private readonly socketTable: SocketTable,
  ) {
    this.subscriptions.push(
      bus.subscribe('windows.service.started', (e) => this.onStarted(e.payload)),
      bus.subscribe('windows.service.stopped', (e) => this.onStopped(e.payload)),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onStarted(p: WindowsServiceEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const spec = WINDOWS_SERVICE_LISTENERS[p.serviceName.toLowerCase()];
    if (!spec) return;
    for (const s of spec.sockets) {
      if (this.socketTable.isPortBound(s.port, s.protocol)) continue;
      try {
        this.socketTable.bind(s.protocol, s.address ?? ALL_INTERFACES, s.port, spec.pid, spec.processName);
      } catch { /* already bound — keep the existing entry */ }
    }
  }

  private onStopped(p: WindowsServiceEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const spec = WINDOWS_SERVICE_LISTENERS[p.serviceName.toLowerCase()];
    if (!spec) return;
    for (const s of spec.sockets) {
      this.socketTable.unbind(s.protocol, s.address ?? ALL_INTERFACES, s.port);
    }
  }
}
