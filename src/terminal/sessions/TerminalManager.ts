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

import { Equipment, isFullyImplemented } from '@/network';
import { TerminalSession } from './TerminalSession';
import { LinuxTerminalSession } from './LinuxTerminalSession';
import { CiscoTerminalSession } from './CiscoTerminalSession';
import { HuaweiTerminalSession } from './HuaweiTerminalSession';
import { WindowsTerminalSession } from './WindowsTerminalSession';
import { preInstallForDevice } from '@/terminal/packages';

let nextSessionId = 1;

export class TerminalManager {
  /** sessionId → session */
  private sessions = new Map<string, TerminalSession>();
  /** deviceId → sessionId[] (for multi-terminal per device) */
  private deviceSessions = new Map<string, string[]>();

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

    const osType = device.getOSType();
    const deviceType = device.getDeviceType();
    const deviceId = device.getId();

    // Pre-install database packages
    if (deviceType.startsWith('db-')) {
      preInstallForDevice(deviceType);
    }

    const sessionId = `session-${nextSessionId++}`;
    let session: TerminalSession;

    switch (osType) {
      case 'linux':
        session = new LinuxTerminalSession(sessionId, device);
        break;
      case 'cisco-ios':
        session = new CiscoTerminalSession(sessionId, device);
        break;
      case 'huawei-vrp':
        session = new HuaweiTerminalSession(sessionId, device);
        break;
      case 'windows':
        session = new WindowsTerminalSession(sessionId, device);
        break;
      default:
        if (!isFullyImplemented(deviceType)) return null;
        // Fallback to linux for fully-implemented but unknown OS types
        session = new LinuxTerminalSession(sessionId, device);
        break;
    }

    this.sessions.set(sessionId, session);
    const deviceSessions = this.deviceSessions.get(deviceId) || [];
    deviceSessions.push(sessionId);
    this.deviceSessions.set(deviceId, deviceSessions);

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

    // Reset Linux session state on close
    if (session.getSessionType() === 'linux') {
      const dev = session.device as any;
      if (typeof dev.resetSession === 'function') dev.resetSession();
    }

    session.dispose();
    this.sessions.delete(sessionId);

    // Remove from device-sessions map
    const deviceSessions = this.deviceSessions.get(deviceId);
    if (deviceSessions) {
      const idx = deviceSessions.indexOf(sessionId);
      if (idx >= 0) deviceSessions.splice(idx, 1);
      if (deviceSessions.length === 0) this.deviceSessions.delete(deviceId);
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
}

// ── Singleton ─────────────────────────────────────────────────────

let _instance: TerminalManager | null = null;

export function getTerminalManager(): TerminalManager {
  if (!_instance) _instance = new TerminalManager();
  return _instance;
}
