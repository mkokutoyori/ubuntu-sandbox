import { useEffect, useState } from 'react';
import type { Equipment } from '@/network';

export interface MacTableRow {
  mac: string;
  vlan: number;
  port: string;
  type: 'dynamic' | 'static';
  timestamp: number;
}

interface MacTableSource {
  getMACTable(): { mac: unknown; vlan: number; port: string; type: 'dynamic' | 'static'; timestamp: number }[];
}

function hasMacTable(dev: unknown): dev is MacTableSource {
  return dev !== null && typeof dev === 'object'
    && typeof (dev as Record<string, unknown>)['getMACTable'] === 'function';
}

const MAC_TOPICS = [
  'switch.mac.learned', 'switch.mac.moved', 'switch.mac.aged',
  'switch.mac.flushed', 'switch.mac.cleared',
] as const;

export function useMacTable(instance: Equipment | null): MacTableRow[] {
  const [, setVersion] = useState(0);
  const deviceId = instance?.getId() ?? null;

  useEffect(() => {
    if (!deviceId) return;
    const bus = instance?.getBus();
    if (!bus) return;
    const subs = MAC_TOPICS.map(topic => bus.subscribe(topic, () => setVersion(v => v + 1)));
    return () => { for (const off of subs) off(); };
  }, [deviceId, instance]);

  if (!instance || !hasMacTable(instance)) return [];
  return instance.getMACTable().map(e => ({
    mac: String(e.mac),
    vlan: e.vlan,
    port: e.port,
    type: e.type,
    timestamp: e.timestamp,
  }));
}
