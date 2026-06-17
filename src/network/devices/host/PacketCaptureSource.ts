import type { IEventBus } from '@/events/EventBus';
import { DebugBroadcast, type DebugLineListener } from '@/network/devices/diag/DebugBroadcast';

export interface CaptureIfaceResolver {
  ipForIface(iface: string): string | null;
}

interface EchoEventPayload {
  deviceId?: string;
  fromIp: string;
  toIp: string;
  id: number;
  seq: number;
  size?: number;
}

interface ArpRequestPayload {
  deviceId?: string;
  iface: string;
  targetIp: string;
}

interface ArpLearnedPayload {
  deviceId?: string;
  ip: string;
  mac: string;
}

export class PacketCaptureSource {
  private readonly broadcast = new DebugBroadcast();

  constructor(private readonly resolver: CaptureIfaceResolver) {}

  subscribe(listener: DebugLineListener): () => void {
    return this.broadcast.subscribe(listener);
  }

  attachToBus(bus: IEventBus, deviceId: string): void {
    if (this.broadcast.attachedDeviceId === deviceId) return;
    this.detachFromBus();
    this.broadcast.attachedDeviceId = deviceId;
    const mine = (p: { deviceId?: string }) => p.deviceId === deviceId;

    this.broadcast.track(bus.subscribe('host.icmp.echo-sent', (e) => {
      const p = e.payload as EchoEventPayload;
      if (!mine(p)) return;
      this.broadcast.fan(`${stamp()} IP ${p.fromIp} > ${p.toIp}: ICMP echo request, id ${p.id}, seq ${p.seq}, length ${p.size ?? 64}`);
    }));
    this.broadcast.track(bus.subscribe('host.icmp.echo-reply', (e) => {
      const p = e.payload as EchoEventPayload;
      if (!mine(p)) return;
      this.broadcast.fan(`${stamp()} IP ${p.fromIp} > ${p.toIp}: ICMP echo reply, id ${p.id}, seq ${p.seq}, length ${p.size ?? 64}`);
    }));
    this.broadcast.track(bus.subscribe('host.arp.request-sent', (e) => {
      const p = e.payload as ArpRequestPayload;
      if (!mine(p)) return;
      const tell = this.resolver.ipForIface(p.iface) ?? '0.0.0.0';
      this.broadcast.fan(`${stamp()} ARP, Request who-has ${p.targetIp} tell ${tell}, length 28`);
    }));
    this.broadcast.track(bus.subscribe('host.arp.entry-learned', (e) => {
      const p = e.payload as ArpLearnedPayload;
      if (!mine(p)) return;
      this.broadcast.fan(`${stamp()} ARP, Reply ${p.ip} is-at ${p.mac}, length 28`);
    }));
  }

  detachFromBus(): void {
    this.broadcast.detach();
  }
}

function stamp(): string {
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${now.toTimeString().slice(0, 8)}.${ms}000`;
}
