/**
 * ServicePortProjection — reactive bridge keeping the kernel socket table
 * coherent with the service layer.
 *
 * A real daemon opens its listening socket when it starts and closes it
 * when it stops; `netstat` / `ss` show exactly the ports of the daemons
 * that are running. This projection reproduces that: it subscribes to the
 * service-lifecycle event stream and binds / unbinds the owning service's
 * listening sockets on the {@link SocketTable} — so `systemctl start nginx`
 * genuinely makes `:80` appear and `systemctl stop nginx` makes it vanish.
 *
 * Coherence delivered: service ⇄ process (the socket carries the unit's
 * `mainPid` and process name) ⇄ port (the SocketTable entry).
 *
 * `ssh` is intentionally excluded: its listener is config-driven (the
 * `Port` directive in `sshd_config`) and is owned by the SSH module in
 * `LinuxMachine`. Binding it here too would double-bind a custom port.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SocketTable } from '../../../core/SocketTable';
import type { ServicePortBinding } from '../LinuxServiceManager';
import type { ServiceLifecyclePayload } from '../events';
import type { PortSpec } from '../../../core/ports/PortNumber';

/** The slice of `LinuxServiceManager` this projection depends on. */
export interface ServicePortSource {
  getPortBinding(name: string): ServicePortBinding | undefined;
  activePortBindings(): ServicePortBinding[];
}

/** Units whose listener is managed elsewhere and must not be touched here. */
const EXCLUDED_UNITS = new Set(['ssh', 'sshd']);

/** Default bind address when a socket spec does not pin one. */
const ALL_INTERFACES = '0.0.0.0';

export class ServicePortProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly socketTable: SocketTable,
    private readonly source: ServicePortSource,
  ) {
    const onUp = (e: { payload: ServiceLifecyclePayload }) => this.bindService(e.payload.name);
    this.subscriptions.push(
      bus.subscribe('linux.service.started', onUp),
      bus.subscribe('linux.service.restarted', onUp),
      bus.subscribe('linux.service.reloaded', onUp),
      bus.subscribe('linux.service.stopped', (e) => this.releaseService(e.payload.name)),
    );
    // Bind whatever is already running — the projection may attach after boot.
    this.reconcile();
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  /** Bind the listening sockets of every currently-active service. */
  reconcile(): void {
    for (const binding of this.source.activePortBindings()) {
      if (EXCLUDED_UNITS.has(binding.name)) continue;
      this.openSockets(binding);
    }
  }

  // ─── Lifecycle reactions ───────────────────────────────────────────────

  private bindService(name: string): void {
    if (EXCLUDED_UNITS.has(name)) return;
    const binding = this.source.getPortBinding(name);
    if (binding) this.openSockets(binding);
  }

  private releaseService(name: string): void {
    if (EXCLUDED_UNITS.has(name)) return;
    const binding = this.source.getPortBinding(name);
    if (binding) this.closeSockets(binding);
  }

  // ─── SocketTable mutation ──────────────────────────────────────────────

  private openSockets(binding: ServicePortBinding): void {
    for (const spec of binding.sockets) {
      const address = spec.address ?? ALL_INTERFACES;
      // Skip a port already bound (e.g. seeded at boot) — bind() throws
      // EADDRINUSE, which would otherwise abort the whole reconcile.
      if (this.socketTable.isPortBound(spec.port, spec.protocol)) continue;
      try {
        this.socketTable.bind(spec.protocol, address, spec.port, binding.mainPid, binding.processName);
      } catch {
        continue;
      }
      this.publishPortEvent('linux.port.bound', binding, spec, address);
    }
  }

  private closeSockets(binding: ServicePortBinding): void {
    for (const spec of binding.sockets) {
      const address = spec.address ?? ALL_INTERFACES;
      const removed = this.socketTable.unbind(spec.protocol, address, spec.port);
      if (removed > 0) {
        this.publishPortEvent('linux.port.released', binding, spec, address);
      }
    }
  }

  private publishPortEvent(
    topic: 'linux.port.bound' | 'linux.port.released',
    binding: ServicePortBinding,
    spec: PortSpec,
    address: string,
  ): void {
    this.bus.publish({
      topic,
      payload: {
        deviceId: this.deviceId,
        port: spec.port,
        protocol: spec.protocol,
        address,
        pid: binding.mainPid,
        processName: binding.processName,
        serviceName: binding.name,
      },
    });
  }
}
