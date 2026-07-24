import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import { WritableSignal, type Signal } from '@/events/Signal';

export interface SmtpMetricsVM {
  readonly sessionsOpened: number;
  readonly sessionsClosed: number;
  readonly commandsReceived: number;
  readonly mailAccepted: number;
  readonly mailRejected: number;
  readonly deliveredLocal: number;
  readonly deliveredRelayed: number;
  readonly deliveryDeferred: number;
  readonly deliveryBounced: number;
  readonly authSucceeded: number;
  readonly authFailed: number;
  readonly tlsEstablished: number;
  readonly dsnGenerated: number;
  readonly queueRetried: number;
  readonly queueExpired: number;
}

const EMPTY_METRICS: SmtpMetricsVM = {
  sessionsOpened: 0, sessionsClosed: 0, commandsReceived: 0,
  mailAccepted: 0, mailRejected: 0,
  deliveredLocal: 0, deliveredRelayed: 0, deliveryDeferred: 0, deliveryBounced: 0,
  authSucceeded: 0, authFailed: 0, tlsEstablished: 0,
  dsnGenerated: 0, queueRetried: 0, queueExpired: 0,
};

export class SmtpSignalStore {
  readonly metrics = new WritableSignal<SmtpMetricsVM>(EMPTY_METRICS);

  private bump(patch: Partial<SmtpMetricsVM>): void {
    this.metrics.set({ ...this.metrics.get(), ...patch });
  }

  incrementSessionsOpened(): void { this.bump({ sessionsOpened: this.metrics.get().sessionsOpened + 1 }); }
  incrementSessionsClosed(): void { this.bump({ sessionsClosed: this.metrics.get().sessionsClosed + 1 }); }
  incrementCommandsReceived(): void { this.bump({ commandsReceived: this.metrics.get().commandsReceived + 1 }); }
  incrementMailAccepted(): void { this.bump({ mailAccepted: this.metrics.get().mailAccepted + 1 }); }
  incrementMailRejected(): void { this.bump({ mailRejected: this.metrics.get().mailRejected + 1 }); }
  incrementDeliveredLocal(): void { this.bump({ deliveredLocal: this.metrics.get().deliveredLocal + 1 }); }
  incrementDeliveredRelayed(): void { this.bump({ deliveredRelayed: this.metrics.get().deliveredRelayed + 1 }); }
  incrementDeliveryDeferred(): void { this.bump({ deliveryDeferred: this.metrics.get().deliveryDeferred + 1 }); }
  incrementDeliveryBounced(): void { this.bump({ deliveryBounced: this.metrics.get().deliveryBounced + 1 }); }
  incrementAuthSucceeded(): void { this.bump({ authSucceeded: this.metrics.get().authSucceeded + 1 }); }
  incrementAuthFailed(): void { this.bump({ authFailed: this.metrics.get().authFailed + 1 }); }
  incrementTlsEstablished(): void { this.bump({ tlsEstablished: this.metrics.get().tlsEstablished + 1 }); }
  incrementDsnGenerated(): void { this.bump({ dsnGenerated: this.metrics.get().dsnGenerated + 1 }); }
  incrementQueueRetried(): void { this.bump({ queueRetried: this.metrics.get().queueRetried + 1 }); }
  incrementQueueExpired(): void { this.bump({ queueExpired: this.metrics.get().queueExpired + 1 }); }
}

export function smtpMetricsSignal(store: SmtpSignalStore): Signal<SmtpMetricsVM> {
  return { get: () => store.metrics.get(), subscribe: (listener) => store.metrics.subscribe(listener) };
}

export function subscribeSmtpObservables(bus: IEventBus, store: SmtpSignalStore): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    bus.subscribe('smtp.session.opened', () => store.incrementSessionsOpened()),
    bus.subscribe('smtp.session.closed', () => store.incrementSessionsClosed()),
    bus.subscribe('smtp.command.received', () => store.incrementCommandsReceived()),
    bus.subscribe('smtp.mail.accepted', () => store.incrementMailAccepted()),
    bus.subscribe('smtp.mail.rejected', () => store.incrementMailRejected()),
    bus.subscribe('smtp.delivery.local', () => store.incrementDeliveredLocal()),
    bus.subscribe('smtp.delivery.relayed', () => store.incrementDeliveredRelayed()),
    bus.subscribe('smtp.delivery.deferred', () => store.incrementDeliveryDeferred()),
    bus.subscribe('smtp.delivery.bounced', () => store.incrementDeliveryBounced()),
    bus.subscribe('smtp.auth.succeeded', () => store.incrementAuthSucceeded()),
    bus.subscribe('smtp.auth.failed', () => store.incrementAuthFailed()),
    bus.subscribe('smtp.starttls.established', () => store.incrementTlsEstablished()),
    bus.subscribe('smtp.dsn.generated', () => store.incrementDsnGenerated()),
    bus.subscribe('smtp.queue.retried', () => store.incrementQueueRetried()),
    bus.subscribe('smtp.queue.expired', () => store.incrementQueueExpired()),
  ];
  return () => unsubs.forEach((u) => u());
}
