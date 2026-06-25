/**
 * TerminalManager — Singleton that manages all terminal sessions.
 *
 * Responsibilities:
 *   - Creates and destroys TerminalSession instances
 *   - Supports multiple terminals per device
 *   - Provides a React-subscribable store
 *   - Sessions survive React mount/unmount cycles (no more lost state)
 *
 * Usage:
 *   const manager = getTerminalManager();
 *   const sessionId = manager.openTerminal(device);
 *   const session = manager.getSession(sessionId);
 *   manager.closeTerminal(sessionId);
 */

import { Equipment } from '@/network';
import { TerminalSession } from './TerminalSession';
import { createSessionForDevice } from './sessionFactory';
import { getDefaultEventBus, type IEventBus, type Unsubscribe } from '@/events/EventBus';

let nextSessionId = 1;

export class TerminalManager {
  /** sessionId → session */
  private sessions = new Map<string, TerminalSession>();
  /** deviceId → sessionId[] (for multi-terminal per device) */
  private deviceSessions = new Map<string, string[]>();
  /** Event bus subscriptions held for the lifetime of the manager. */
  private busSubs: Unsubscribe[] = [];
  /** Bus this manager listens on (null = lazily resolved). */
  private bus: IEventBus | null = null;

  constructor(bus?: IEventBus) {
    this.bus = bus ?? null;
    this.attachToBus();
  }

  // ── Event-bus wiring ────────────────────────────────────────────

  /**
   * Subscribe to Equipment lifecycle events. Idempotent — re-attaching
   * detaches the previous subscriptions first.
   *
   * Driven topics:
   *   - device.power-off    → freeze all terminals on the device (read-only,
   *                            "Connection to <host> lost" notice).
   *   - device.power-on     → unfreeze them and signal readiness.
   *   - device.removed,
   *     device.deregistered → dispose all terminals on the device.
   *   - registry.cleared    → dispose every terminal.
   */
  private attachToBus(): void {
    this.detachFromBus();
    const bus = this.bus ?? getDefaultEventBus();
    this.busSubs.push(
      bus.subscribe('device.power-off', ({ payload }) => {
        this.onDevicePoweredOff(payload.id);
      }),
      bus.subscribe('device.power-on', ({ payload }) => {
        this.onDevicePoweredOn(payload.id);
      }),
      bus.subscribe('device.removed', ({ payload }) => {
        this.onDeviceRemoved(payload.id, payload.name);
      }),
      bus.subscribe('device.deregistered', ({ payload }) => {
        this.onDeviceRemoved(payload.id, '');
      }),
      bus.subscribe('registry.cleared', () => {
        this.disposeAll();
      }),
    );
  }

  private detachFromBus(): void {
    for (const u of this.busSubs) {
      try { u(); } catch { /* ignore */ }
    }
    this.busSubs = [];
  }

  /** Allow tests to swap the bus. Re-wires subscriptions. */
  setEventBus(bus: IEventBus | null): void {
    this.bus = bus;
    this.attachToBus();
  }

  // ── Lifecycle reactions ─────────────────────────────────────────

  private onDevicePoweredOff(deviceId: string): void {
    const ids = this.deviceSessions.get(deviceId);
    if (!ids || ids.length === 0) return;
    for (const sid of ids) {
      const s = this.sessions.get(sid);
      if (!s || s.disposed) continue;
      const host = s.device.getHostname() || s.device.getName();
      s.markDisconnected('device-off', `Connection to ${host} lost: device powered off.`);
    }
    this.notify();
  }

  private onDevicePoweredOn(deviceId: string): void {
    const ids = this.deviceSessions.get(deviceId);
    if (!ids || ids.length === 0) return;
    for (const sid of ids) {
      const s = this.sessions.get(sid);
      if (!s || s.disposed) continue;
      if (s.isDisconnected) {
        s.markReconnected();
      }
    }
    this.notify();
  }

  private onDeviceRemoved(deviceId: string, _name: string): void {
    const ids = this.deviceSessions.get(deviceId);
    if (!ids || ids.length === 0) return;
    // Copy: closeTerminal mutates the array.
    for (const sid of [...ids]) {
      this.closeTerminal(sid);
    }
  }

  private disposeAll(): void {
    if (this.sessions.size === 0) return;
    for (const sid of [...this.sessions.keys()]) {
      this.closeTerminal(sid);
    }
  }

  // ── Observable store ────────────────────────────────────────────
  private _version = 0;
  private _listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  getVersion = (): number => this._version;

  private notify(): void {
    this._version++;
    for (const l of this._listeners) l();
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Open a new terminal for a device.  Returns the session ID.
   * Starts the session's init() (boot sequence, etc.) asynchronously.
   */
  openTerminal(device: Equipment): string | null {
    if (!device.getIsPoweredOn()) return null;

    const deviceId = device.getId();

    const sessionId = `session-${nextSessionId++}`;
    const session = createSessionForDevice(device, sessionId);
    if (!session) return null;

    this.sessions.set(sessionId, session);
    const deviceSessions = this.deviceSessions.get(deviceId) || [];
    deviceSessions.push(sessionId);
    this.deviceSessions.set(deviceId, deviceSessions);

    // Wire up the exit/logout close callback so typing "exit" closes the terminal
    if (typeof (session as any).onRequestClose === 'function') {
      (session as any).onRequestClose(() => {
        this.closeTerminal(sessionId);
      });
    }

    // Start initialization asynchronously (boot sequence, etc.)
    session.init().catch(() => {});

    this.notify();
    return sessionId;
  }

  /**
   * Close and dispose a terminal session.
   * The session is permanently destroyed (requirement #2).
   */
  closeTerminal(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const deviceId = session.device.getId();

    // Per-terminal cleanup (su stack, cwd, env, -bash PID, pts slot) is
    // delegated to the session's tear-down hooks — which the LinuxTerminal
    // session registers in its constructor. We must NOT call the executor's
    // global resetSession() here: it would also clobber the state of any
    // other terminal still open on the same device (terminal_gap.md §2.3).

    session.dispose();
    this.sessions.delete(sessionId);

    // Remove from device-sessions map
    const deviceSessions = this.deviceSessions.get(deviceId);
    if (deviceSessions) {
      const idx = deviceSessions.indexOf(sessionId);
      if (idx >= 0) deviceSessions.splice(idx, 1);
      if (deviceSessions.length === 0) {
        this.deviceSessions.delete(deviceId);
        session.device.clearBootShown();
      }
    }

    this.notify();
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions as a Map (for iterating in the UI).
   */
  getAllSessions(): Map<string, TerminalSession> {
    return this.sessions;
  }

  /**
   * Get all session IDs for a device.
   */
  getSessionsForDevice(deviceId: string): string[] {
    return this.deviceSessions.get(deviceId) || [];
  }

  /**
   * Check if a device has any open terminals.
   */
  hasTerminal(deviceId: string): boolean {
    const sessions = this.deviceSessions.get(deviceId);
    return !!sessions && sessions.length > 0;
  }

  /**
   * Total number of open sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Close all sessions for a specific device.
   * Useful when a device is powered off or deleted.
   */
  closeAllForDevice(deviceId: string): void {
    const sessionIds = this.deviceSessions.get(deviceId);
    if (!sessionIds || sessionIds.length === 0) return;

    // Copy the array since closeTerminal mutates it
    for (const sessionId of [...sessionIds]) {
      this.closeTerminal(sessionId);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let _instance: TerminalManager | null = null;

export function getTerminalManager(): TerminalManager {
  if (!_instance) _instance = new TerminalManager();
  return _instance;
}
