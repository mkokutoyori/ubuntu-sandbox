import { EventBus, type IEventBus } from './EventBus';

export class BusHolder {
  private injected: IEventBus | null = null;
  private own: EventBus | null = null;

  constructor(injected: IEventBus | null = null) {
    this.injected = injected;
  }

  set(bus: IEventBus | null): void { this.injected = bus; }

  get(): IEventBus {
    if (this.injected) return this.injected;
    if (!this.own) this.own = new EventBus();
    return this.own;
  }

  isOwned(): boolean { return this.injected !== null; }
}

export function detachedBus(): IEventBus { return new EventBus(); }

export function ownBusProvider(): () => IEventBus {
  const holder = new BusHolder();
  return () => holder.get();
}
