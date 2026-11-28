import { getDefaultScheduler, type TimerHandle } from '@/events/Scheduler';

export const OBSERVER_PING_INTERVAL_MS = 3000;

export interface ObserverConfigView {
  fsfo: { enabled: boolean; threshold: number; target: string | null };
  members: [string, { identifier: string }][];
}

export interface ObserverPorts {
  ask(identifier: string, command: string): string[] | null;
  sql(identifier: string, statement: string): boolean;
}

const running = new Map<string, TimerHandle>();

export function stopObserver(deviceId: string, name: string): void {
  const handle = running.get(`${deviceId}|${name}`);
  if (handle !== undefined) getDefaultScheduler().clear(handle);
  running.delete(`${deviceId}|${name}`);
}

export function startObserver(deviceId: string, name: string, primaryIdentifier: string, ports: ObserverPorts): void {
  stopObserver(deviceId, name);
  const scheduler = getDefaultScheduler();
  let unreachableMs = 0;
  let lastTargetPing = scheduler.now();
  let view: ObserverConfigView | null = null;
  const parse = (lines: string[] | null): ObserverConfigView | null => {
    try { return lines === null ? null : (JSON.parse(lines.join('\n')) as ObserverConfigView); } catch { return null; }
  };
  const tick = (): void => {
    const reply = ports.ask(primaryIdentifier, `OBSERVER PING ${name} ${lastTargetPing}`);
    if (reply !== null && reply[0] === 'unknown') { stopObserver(deviceId, name); return; }
    if (reply !== null) {
      unreachableMs = 0;
      view = parse(ports.ask(primaryIdentifier, 'EXPORT CONFIGURATION')) ?? view;
      const target = view?.members.find(([name]) => name === view?.fsfo.target) ?? view?.members[0];
      if (target !== undefined && ports.ask(target[1].identifier, 'EXPORT CONFIGURATION') !== null) lastTargetPing = scheduler.now();
      return;
    }
    unreachableMs += OBSERVER_PING_INTERVAL_MS;
    if (view === null || !view.fsfo.enabled || unreachableMs < view.fsfo.threshold * 1000) return;
    const target = view.members.find(([name]) => name === view?.fsfo.target) ?? view.members[0];
    if (target === undefined || ports.ask(target[1].identifier, 'EXPORT CONFIGURATION') === null) return;
    ports.ask(target[1].identifier, `FAILOVER TO '${target[0]}'`);
    ports.sql(target[1].identifier, 'ALTER DATABASE OPEN');
    stopObserver(deviceId, name);
  };
  running.set(`${deviceId}|${name}`, scheduler.setInterval(tick, OBSERVER_PING_INTERVAL_MS));
  tick();
}
