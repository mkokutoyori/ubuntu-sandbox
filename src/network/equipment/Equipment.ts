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

export abstract class Equipment {
  /** Global registry of all Equipment instances (for topology traversal) */
  private static registry: Map<string, Equipment> = new Map();

  static getById(id: string): Equipment | undefined { return Equipment.registry.get(id); }
  static getAllEquipment(): Equipment[] { return Array.from(Equipment.registry.values()); }
  static clearRegistry(): void { Equipment.registry.clear(); }

  protected readonly id: string;
  protected name: string;
  protected hostname: string;
  protected readonly deviceType: DeviceType;
  protected x: number;
  protected y: number;
  protected isPoweredOn: boolean = true;
  protected ports: Map<string, Port> = new Map();

  constructor(deviceType: DeviceType, name: string, x: number = 0, y: number = 0) {
    this.id = generateId();
    this.deviceType = deviceType;
    this.name = name;
    this.hostname = name;
    this.x = x;
    this.y = y;
    Equipment.registry.set(this.id, this);
  }

  // ─── Identity ───────────────────────────────────────────────────

  getId(): string { return this.id; }
  getName(): string { return this.name; }
  getHostname(): string { return this.hostname; }
  getType(): DeviceType { return this.deviceType; }
  getDeviceType(): DeviceType { return this.deviceType; }

  /**
   * Get the current working directory (for terminal prompt).
   * Override in subclasses that track cwd (e.g. LinuxPC, LinuxServer).
   */
  getCwd(): string { return '/'; }

  /**
   * Get tab completions for a partial input string.
   * Override in subclasses that support tab completion.
   */
  getCompletions(partial: string): string[] { return []; }

  /** Get current username (for terminal prompt). Override in subclasses. */
  getCurrentUser(): string { return 'user'; }

  /** Handle exit/logout for su sessions. Override in subclasses. */
  handleExit(): { output: string; inSu: boolean } { return { output: '', inSu: false }; }

  /** Check password for a user. Override in Linux devices. */
  checkPassword(_username: string, _password: string): boolean { return false; }

  /** Set password for a user. Override in Linux devices. */
  setUserPassword(_username: string, _password: string): void {}

  /** Check if a user exists. Override in Linux devices. */
  userExists(_username: string): boolean { return false; }

  /** Get current UID (0 = root). Override in Linux devices. */
  getCurrentUid(): number { return 0; }

  /**
   * Get the OS type for terminal selection.
   * Override in subclasses for specific OS types.
   */
  getOSType(): string {
    const t = this.deviceType;
    if (t.startsWith('linux') || t === 'mac-pc') return 'linux';
    if (t.startsWith('windows')) return 'windows';
    if (t.includes('cisco')) return 'cisco-ios';
    return 'linux'; // Default to linux terminal for unknown types
  }

  setName(name: string): void { this.name = name; }
  setHostname(hostname: string): void { this.hostname = hostname; }

  // ─── Position ──────────────────────────────────────────────────

  getPosition(): { x: number; y: number } { return { x: this.x, y: this.y }; }
  setPosition(x: number, y: number): void { this.x = x; this.y = y; }

  // ─── Power ─────────────────────────────────────────────────────

  getIsPoweredOn(): boolean { return this.isPoweredOn; }

  powerOn(): void {
    this.isPoweredOn = true;
    Logger.info(this.id, 'equipment:power', `${this.name}: powered ON`);
  }

  powerOff(): void {
    this.isPoweredOn = false;
    Logger.info(this.id, 'equipment:power', `${this.name}: powered OFF`);
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
