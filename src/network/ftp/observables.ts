/**
 * PRD-FTP-SFTP.md §2.1.12 — observable read-model (Signal) over
 * `events.ts`'s topics. Like `network/http/observables.ts`: control
 * connections and transfers are short-lived, high-cardinality events, so
 * the useful read-model is a single aggregate counters view, the same
 * shape a real metrics dashboard would show.
 */
import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';

export interface FtpMetricsVM {
  readonly controlConnected: number;
  readonly controlAuthenticated: number;
  readonly controlClosed: number;
  readonly openDataChannels: number;
  readonly commandsReceived: number;
  readonly transfersStarted: number;
  readonly transfersCompleted: number;
  readonly transfersFailed: number;
  readonly tlsEstablished: number;
}

const EMPTY_METRICS: FtpMetricsVM = {
  controlConnected: 0, controlAuthenticated: 0, controlClosed: 0,
  openDataChannels: 0, commandsReceived: 0,
  transfersStarted: 0, transfersCompleted: 0, transfersFailed: 0,
  tlsEstablished: 0,
};

export class FtpSignalStore {
  readonly metrics = new WritableSignal<FtpMetricsVM>(EMPTY_METRICS);

  private bump(patch: Partial<FtpMetricsVM>): void {
    const current = this.metrics.get();
    this.metrics.set({ ...current, ...patch });
  }

  incrementControlConnected(): void { this.bump({ controlConnected: this.metrics.get().controlConnected + 1 }); }
  incrementControlAuthenticated(): void { this.bump({ controlAuthenticated: this.metrics.get().controlAuthenticated + 1 }); }
  incrementControlClosed(): void { this.bump({ controlClosed: this.metrics.get().controlClosed + 1 }); }
  adjustOpenDataChannels(delta: number): void { this.bump({ openDataChannels: this.metrics.get().openDataChannels + delta }); }
  incrementCommandsReceived(): void { this.bump({ commandsReceived: this.metrics.get().commandsReceived + 1 }); }
  incrementTransfersStarted(): void { this.bump({ transfersStarted: this.metrics.get().transfersStarted + 1 }); }
  incrementTransfersCompleted(): void { this.bump({ transfersCompleted: this.metrics.get().transfersCompleted + 1 }); }
  incrementTransfersFailed(): void { this.bump({ transfersFailed: this.metrics.get().transfersFailed + 1 }); }
  incrementTlsEstablished(): void { this.bump({ tlsEstablished: this.metrics.get().tlsEstablished + 1 }); }
}

export function ftpMetricsSignal(store: FtpSignalStore): Signal<FtpMetricsVM> {
  return { get: () => store.metrics.get(), subscribe: (listener) => store.metrics.subscribe(listener) };
}

/** Wires an `FtpSignalStore` to an event bus's `ftp.*`/`ftps.*` topics; returns a single combined unsubscribe. */
export function subscribeFtpObservables(bus: IEventBus, store: FtpSignalStore): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    bus.subscribe('ftp.control.connected', () => store.incrementControlConnected()),
    bus.subscribe('ftp.control.authenticated', () => store.incrementControlAuthenticated()),
    bus.subscribe('ftp.control.closed', () => store.incrementControlClosed()),
    bus.subscribe('ftp.data.opened', () => store.adjustOpenDataChannels(1)),
    bus.subscribe('ftp.data.closed', () => store.adjustOpenDataChannels(-1)),
    bus.subscribe('ftp.command.received', () => store.incrementCommandsReceived()),
    bus.subscribe('ftp.transfer.started', () => store.incrementTransfersStarted()),
    bus.subscribe('ftp.transfer.completed', () => store.incrementTransfersCompleted()),
    bus.subscribe('ftp.transfer.failed', () => store.incrementTransfersFailed()),
    bus.subscribe('ftps.tls.established', () => store.incrementTlsEstablished()),
  ];
  return () => unsubs.forEach((u) => u());
}
