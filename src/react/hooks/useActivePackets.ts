import { useEffect, useRef, useState } from 'react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP,
} from '@/network/core/types';
import type { ActivePacket } from '@/components/network/PacketAnimation';

const ANIMATION_DURATION_MS = 600;
const MAX_CONCURRENT_PACKETS = 64;

interface FrameDispatchedPayload {
  cableId: string;
  from: { deviceId: string; portName: string };
  to: { deviceId: string; portName: string };
  frame: {
    dstMAC: { toString(): string };
    etherType: number;
    payload?: { type?: string; protocol?: number } | undefined;
  };
}

function classifyPacket(frame: FrameDispatchedPayload['frame']): ActivePacket['type'] {
  const dst = frame.dstMAC?.toString?.() ?? '';
  if (dst.toLowerCase() === 'ff:ff:ff:ff:ff:ff') return 'broadcast';
  if (frame.etherType === ETHERTYPE_ARP) return 'arp';
  if (frame.etherType === ETHERTYPE_IPV4 && frame.payload?.protocol === IP_PROTO_ICMP) return 'icmp';
  return 'data';
}

export function useActivePackets(): ActivePacket[] {
  const [packets, setPackets] = useState<ActivePacket[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const registry = EquipmentRegistry.getInstance();
    let counter = 0;
    let taps: Array<() => void> = [];

    const record = (deviceId: string, iface: string, frame: unknown): void => {
      const device = registry.getById(deviceId);
      const port = device?.getPort(iface);
      const cable = port?.getCable();
      const far = cable ? (cable.getPortA() === port ? cable.getPortB() : cable.getPortA()) : null;
      if (!cable || !far) return;
      const next: ActivePacket = {
        id: `pkt-${Date.now()}-${counter++}`,
        connectionId: cable.getId(),
        sourceDeviceId: deviceId,
        destinationDeviceId: far.getEquipmentId(),
        progress: 0,
        type: classifyPacket(frame as never),
        startTime: performance.now(),
      };
      setPackets((current) => {
        if (current.length >= MAX_CONCURRENT_PACKETS) return [...current.slice(1), next];
        return [...current, next];
      });
    };

    const rebind = (): void => {
      for (const off of taps) off();
      taps = registry.getAll().map(device => device.attachCapture((tapped) => {
        if (tapped.direction !== 'out') return;
        record(device.getId(), tapped.iface, tapped.frame);
      }));
    };
    rebind();
    const offRegistry = registry.subscribe(rebind);
    const off = () => { offRegistry(); for (const t of taps) t(); };
    return off;
  }, []);

  useEffect(() => {
    if (packets.length === 0) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    const tick = (): void => {
      const now = performance.now();
      setPackets((current) => {
        const updated: ActivePacket[] = [];
        for (const p of current) {
          const elapsed = now - (p.startTime ?? now);
          const progress = Math.min(1, elapsed / ANIMATION_DURATION_MS);
          if (progress < 1) updated.push({ ...p, progress });
        }
        return updated;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [packets.length]);

  return packets;
}
