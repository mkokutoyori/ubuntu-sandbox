import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { HostAddressChangedPayload, HostLinkStateChangedPayload } from '@/network/devices/host/events';
import type { FlowView } from './ConnectionTracker';

export interface FlowTable {
  delete(matches: (view: FlowView) => boolean): readonly FlowView[];
}

export class MasqueradeFlowProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(bus: IEventBus, private readonly flows: FlowTable, private readonly deviceId: string) {
    this.subscriptions.push(
      bus.subscribe('host.link.state-changed', (e) => this.onLinkState(e.payload)),
      bus.subscribe('host.address.changed', (e) => this.onAddress(e.payload)),
    );
  }

  dispose(): void {
    for (const off of this.subscriptions.splice(0)) off();
  }

  private onLinkState(payload: HostLinkStateChangedPayload): void {
    if (payload.deviceId !== this.deviceId || payload.up) return;
    this.flows.delete((view) => view.masqueradeInterface === payload.iface);
  }

  private onAddress(payload: HostAddressChangedPayload): void {
    if (payload.deviceId !== this.deviceId || payload.added) return;
    this.flows.delete((view) => view.masqueradeInterface === payload.iface && view.reply.dstIP === payload.ip);
  }
}
