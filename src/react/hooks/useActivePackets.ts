import { useEffect, useRef, useState } from 'react';
import { getDefaultEventBus } from '@/events/EventBus';
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
    const bus = getDefaultEventBus();
    let counter = 0;
    const off = bus.subscribe('cable.frame.dispatched', (event) => {
      const payload = event.payload as FrameDispatchedPayload;
      if (!payload || !payload.cableId || !payload.from || !payload.to) return;
      const id = `pkt-${Date.now()}-${counter++}`;
      const startTime = performance.now();
      const next: ActivePacket = {
        id,
        connectionId: payload.cableId,
        sourceDeviceId: payload.from.deviceId,
        destinationDeviceId: payload.to.deviceId,
        progress: 0,
        type: classifyPacket(payload.frame),
        startTime,
      };
      setPackets((current) => {
        if (current.length >= MAX_CONCURRENT_PACKETS) return [...current.slice(1), next];
        return [...current, next];
      });
    });
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
