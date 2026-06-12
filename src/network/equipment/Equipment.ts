/**
 * Equipment - Base class for all network equipment
 *
 * Every piece of equipment has:
 * - An ID and name
 * - A position on the canvas (x, y)
 * - A set of physical Ports
 * - Power state (on/off)
 * - The ability to send/receive frames
 *
 * Subclasses implement handleFrame() to define behavior:
 * - Switch: MAC learning + forwarding
 * - PC/Server: ARP + ICMP + terminal
 * - Router: routing table + forwarding
 */

import { Port } from '../hardware/Port';
import { EthernetFrame, DeviceType, generateId } from '../core/types';
import { Logger } from '../core/Logger';
import { EquipmentRegistry } from './EquipmentRegistry';
import { DEVICE_CATALOG } from '../core/deviceCatalog';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';

export abstract class Equipment {
  /**
   * Global registry of all Equipment instances (for topology traversal).
   * @deprecated Use EquipmentRegistry.getInstance() for new code.
   * These static methods delegate to the singleton EquipmentRegistry.
   */
  private static get registry(): EquipmentRegistry { return EquipmentRegistry.getInstance(); }

  static getById(id: string): Equipment | undefined { return EquipmentRegistry.getInstance().getById(id); }
  static getAllEquipment(): Equipment[] { return EquipmentRegistry.getInstance().getAll(); }
  static clearRegistry(): void { EquipmentRegistry.getInstance().clear(); }

  protected readonly id: string;
  protected name: string;
  protected hostname: string;
  protected readonly deviceType: DeviceType;
  protected x: number;
  protected y: number;
  protected isPoweredOn: boolean = true;
  protected ports: Map<string, Port> = new Map();
  protected readonly bootedAtMs: number = Date.now();

  getUptimeMs(): number { return Math.max(0, Date.now() - this.bootedAtMs); }
  getBootedAtMs(): number { return this.bootedAtMs; }

  /** Optional bus override (Phase 2 of the reactive refactor). */
  private busOverride: IEventBus | null = null;

  constructor(deviceType: DeviceType, name: string, x: number = 0, y: number = 0) {
    this.id = generateId();
    this.deviceType = deviceType;
    this.name = name;
    this.hostname = name;
    this.x = x;
    this.y = y;
    EquipmentRegistry.getInstance().register(this);
  }

  /** Inject a custom bus (test-only / multi-topology scenarios). */
  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
    // Cascade to hardware children so the Port-level events
    // (port.frame.*, port.security.*) reach the same observer the
    // equipment's events reach.
    for (const port of this.ports.values()) port.setEventBus(bus);
  }

  protected getBus(): IEventBus {
    return this.busOverride ?? getDefaultEventBus();
  }

  // ─── Identity ───────────────────────────────────────────────────

  getId(): string { return this.id; }
  getName(): string { return this.name; }
  getHostname(): string { return this.hostname; }
  getType(): DeviceType { return this.deviceType; }
  getDeviceType(): DeviceType { return this.deviceType; }

  /**
   * Get tab completions for a partial input string.
   * Override in subclasses that support tab completion.
   */
  getCompletions(partial: string): string[] { return []; }

  // Host capabilities (users, cwd, editable files) live in HostCapabilities.ts.

  /** Execute a command on this device. Override in concrete device classes. */
  executeCommand(_command: string): Promise<string> { return Promise.resolve(''); }

  /**
   * Get the OS type for terminal selection.
   * Override in subclasses for specific OS types.
   */
  getOSType(): string {
    return DEVICE_CATALOG[this.deviceType]?.osType ?? 'linux';
  }

  setName(name: string): void {
    const oldName = this.name;
    if (oldName === name) return;
    this.name = name;
    this.getBus().publish({
      topic: 'device.renamed',
      payload: { id: this.id, oldName, newName: name },
    });
  }
  setHostname(hostname: string): void { this.hostname = hostname; }

  // ─── Position ──────────────────────────────────────────────────

  getPosition(): { x: number; y: number } { return { x: this.x, y: this.y }; }
  setPosition(x: number, y: number): void {
    if (this.x === x && this.y === y) return;
    this.x = x;
    this.y = y;
    this.getBus().publish({
      topic: 'device.position-changed',
      payload: { id: this.id, x, y },
    });
  }

  // ─── Power ─────────────────────────────────────────────────────

  getIsPoweredOn(): boolean { return this.isPoweredOn; }

  /**
   * True iff the device has booted at least once since the last power
   * cycle. Set by `powerOn()` on a *real* off→on transition, cleared by
   * `powerOff()`. Consumed by CLI sessions to skip the boot banner when
   * opening a second terminal on an already-running device (matches real
   * Cisco / Huawei: plugging a console to a running router shows just a
   * prompt, never the System Bootstrap banner).
   */
  private _bootShown: boolean = false;

  /** Whether the post-boot banner has already been rendered for this device. */
  hasBootBeenShown(): boolean { return this._bootShown; }

  /**
   * Mark the boot banner as shown — called by terminal sessions after they
   * have rendered the boot lines on the FIRST opened session post power-on.
   * Idempotent.
   */
  markBootShown(): void { this._bootShown = true; }

  powerOn(): void {
    const wasOn = this.isPoweredOn;
    this.isPoweredOn = true;
    if (!wasOn) {
      // A real power-cycle resets the "boot already rendered" flag so the
      // very next terminal opens at boot-banner stage.
      this._bootShown = false;
    }
    Logger.info(this.id, 'equipment:power', `${this.name}: powered ON`);
    if (!wasOn) {
      this.getBus().publish({
        topic: 'device.power-on',
        payload: { id: this.id },
      });
    }
  }

  powerOff(): void {
    const wasOn = this.isPoweredOn;
    this.isPoweredOn = false;
    // Clear boot flag so the next powerOn replays the boot banner.
    this._bootShown = false;
    Logger.info(this.id, 'equipment:power', `${this.name}: powered OFF`);
    if (wasOn) {
      this.getBus().publish({
        topic: 'device.power-off',
        payload: { id: this.id },
      });
    }
  }

  // ─── Ports ─────────────────────────────────────────────────────

  getPort(name: string): Port | undefined {
    return this.ports.get(name);
  }

  getPorts(): Port[] {
    return Array.from(this.ports.values());
  }

  getPortNames(): string[] {
    return Array.from(this.ports.keys());
  }

  /**
   * Register a port on this equipment.
   * Sets up the frame handler so incoming frames route to handleFrame().
   */
  protected addPort(port: Port): void {
    port.setEquipmentId(this.id);
    if (this.busOverride) port.setEventBus(this.busOverride);
    port.onFrame((portName, frame) => {
      if (!this.isPoweredOn) {
        Logger.warn(this.id, 'equipment:frame-dropped', `${this.name}: powered off, dropping frame on ${portName}`);
        return;
      }
      this.handleFrame(portName, frame);
    });
    this.ports.set(port.getName(), port);
  }

  /**
   * Send a frame out of a specific port
   */
  protected sendFrame(portName: string, frame: EthernetFrame): boolean {
    if (!this.isPoweredOn) {
      Logger.warn(this.id, 'equipment:send-blocked', `${this.name}: powered off, cannot send`);
      return false;
    }

    const port = this.ports.get(portName);
    if (!port) {
      Logger.error(this.id, 'equipment:send-error', `${this.name}: port ${portName} not found`);
      return false;
    }

    return port.sendFrame(frame);
  }

  // ─── Abstract ──────────────────────────────────────────────────

  /**
   * Handle an incoming frame on a port. Subclasses must implement this.
   */
  protected abstract handleFrame(portName: string, frame: EthernetFrame): void;
}
