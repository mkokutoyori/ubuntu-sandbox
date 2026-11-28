import { getDefaultScheduler, type TimerHandle } from '@/events/Scheduler';

export const OBSERVER_PING_INTERVAL_MS = 3000;

export interface ObserverConfigView {
  fsfo: { enabled: boolean; threshold: number; target: string | null; lagLimit: number };
  protectionMode: string;
  members: [string, { identifier: string; needsReinstate?: boolean }][];
}

export interface ObserverPorts {
  ask(identifier: string, command: string): string[] | null;
  sql(identifier: string, statement: string): boolean;
}

const running = new Map<string, TimerHandle>();

const whenStopped = new Map<string, Set<() => void>>();

const observersOf = (deviceId: string): string[] => [...running.keys()].filter((key) => key.startsWith(`${deviceId}|`)).map((key) => key.slice(deviceId.length + 1));

export function stopObserver(deviceId: string, name: string): void {
  const handle = running.get(`${deviceId}|${name}`);
  if (handle !== undefined) getDefaultScheduler().clear(handle);
  running.delete(`${deviceId}|${name}`);
  if (observersOf(deviceId).length > 0) return;
  const waiting = whenStopped.get(deviceId);
  whenStopped.delete(deviceId);
  waiting?.forEach((notify) => notify());
}

export function stopObserversOf(deviceId: string): void {
  observersOf(deviceId).forEach((name) => stopObserver(deviceId, name));
}

export function untilObserversStop(deviceId: string, notify: () => void): void {
  if (observersOf(deviceId).length === 0) { notify(); return; }
  whenStopped.set(deviceId, (whenStopped.get(deviceId) ?? new Set()).add(notify));
}

export function startObserver(deviceId: string, name: string, initialPrimaryIdentifier: string, ports: ObserverPorts): void {
  stopObserver(deviceId, name);
  const scheduler = getDefaultScheduler();
  let primaryIdentifier = initialPrimaryIdentifier;
  let unreachableMs = 0;
  const reinstating = new Set<string>();
  let lastTargetPing = scheduler.now();
  let lastTargetLag = 0;
  let view: ObserverConfigView | null = null;
  const parse = (lines: string[] | null): ObserverConfigView | null => {
    try { return lines === null ? null : (JSON.parse(lines.join('\n')) as ObserverConfigView); } catch { return null; }
  };
  const tick = (): void => {
    const reply = ports.ask(primaryIdentifier, `OBSERVER PING ${name} ${lastTargetPing}`);
    if (reply !== null && reply[0] === 'unknown') { stopObserver(deviceId, name); return; }
    const raised = reply !== null && reply[0] === 'condition';
    if (reply !== null && !raised) {
      unreachableMs = 0;
      view = parse(ports.ask(primaryIdentifier, 'EXPORT CONFIGURATION')) ?? view;
      const target = view?.members.find(([name]) => name === view?.fsfo.target) ?? view?.members[0];
      if (target !== undefined && ports.ask(target[1].identifier, 'EXPORT CONFIGURATION') !== null) lastTargetPing = scheduler.now();
      lastTargetLag = Number(ports.ask(primaryIdentifier, `EXPORT LAG ${target?.[0] ?? ''}`)?.[0]) || 0;
      for (const [lost, member] of view?.members ?? []) {
        if (member.needsReinstate !== true) { reinstating.delete(lost); continue; }
        if (ports.ask(member.identifier, 'EXPORT CONFIGURATION') === null) { reinstating.delete(lost); continue; }
        if (reinstating.has(lost)) continue;
        reinstating.add(lost);
        ports.ask(primaryIdentifier, `REINSTATE DATABASE '${lost}'`);
      }
      return;
    }
    unreachableMs += OBSERVER_PING_INTERVAL_MS;
    if (view === null || !view.fsfo.enabled || (!raised && unreachableMs < view.fsfo.threshold * 1000)) return;
    const target = view.members.find(([name]) => name === view?.fsfo.target) ?? view.members[0];
    if (target === undefined || ports.ask(target[1].identifier, 'EXPORT CONFIGURATION') === null) return;
    if (view.protectionMode === 'MAXIMUM PERFORMANCE' && lastTargetLag > view.fsfo.lagLimit) return;
    ports.ask(target[1].identifier, `OBSERVER FAILOVER TO '${target[0]}'`);
    ports.sql(target[1].identifier, 'ALTER DATABASE OPEN');
    primaryIdentifier = target[1].identifier;
    unreachableMs = 0;
    view = null;
  };
  running.set(`${deviceId}|${name}`, scheduler.setInterval(tick, OBSERVER_PING_INTERVAL_MS));
  tick();
}
