import type { DomainEvent, DomainEventTopic, EventOf } from '@/events/types';
import type { Unsubscribe } from '@/events/EventBus';
import { EquipmentRegistry } from './EquipmentRegistry';
import type { Equipment } from './Equipment';

export type DeviceEventHandler<T extends DomainEventTopic> =
  (event: EventOf<T>, device: Equipment) => void;

export function watchDevices<T extends DomainEventTopic>(
  topics: readonly T[],
  handler: DeviceEventHandler<T>,
): Unsubscribe {
  const watched = new Map<string, { bus: unknown; subs: Unsubscribe[] }>();

  const stopWatching = (id: string): void => {
    const entry = watched.get(id);
    if (!entry) return;
    for (const stop of entry.subs) { try { stop(); } catch { /* already gone */ } }
    watched.delete(id);
  };

  const startWatching = (device: Equipment): void => {
    const id = device.getId();
    const bus = device.getBus();
    if (watched.get(id)?.bus === bus) return;
    stopWatching(id);
    watched.set(id, {
      bus,
      subs: topics.map(topic =>
        bus.subscribe(topic, (event: DomainEvent) => handler(event as EventOf<T>, device))),
    });
  };

  const resync = (): void => {
    const registry = EquipmentRegistry.getInstance();
    const live = new Set<string>();
    for (const device of registry.getAll()) {
      live.add(device.getId());
      startWatching(device);
    }
    for (const id of [...watched.keys()]) {
      if (!live.has(id)) stopWatching(id);
    }
  };

  const stopRegistry = EquipmentRegistry.getInstance().subscribe(resync);
  resync();

  return () => {
    stopRegistry();
    for (const id of [...watched.keys()]) stopWatching(id);
  };
}
