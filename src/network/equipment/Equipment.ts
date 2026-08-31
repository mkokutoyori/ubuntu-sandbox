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
import { EthernetFrame, DeviceType, MACAddress, generateId } from '../core/types';
import { Logger } from '../core/Logger';
import { LinkLayer } from '../layers/link/LinkLayer';
import { TapPoint, type FrameTap, type DetachTap } from '../hardware/PortTap';
import { EquipmentRegistry } from './EquipmentRegistry';
import { DEVICE_CATALOG } from '../core/deviceCatalog';
import { EventBus, type IEventBus } from '@/events/EventBus';

export abstract class Equipment {
  readonly id: string;
  name: string;
  protected hostname: string;
  protected readonly deviceType: DeviceType;
  protected x: number;
  protected y: number;
  protected isPoweredOn: boolean = true;
  protected ports: Map<string, Port> = new Map();
  protected readonly bootedAtMs: number = Date.now();

  private _enableSecret: { value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' } | null = null;
  private _enablePassword: { value: string; algo: 'plain' | 'type-7' } | null = null;

  getEnableSecret(): { value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' } | null { return this._enableSecret; }
  _setEnableSecret(value: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7'): void {
    this._enableSecret = value === '' ? null : { value, algo };
  }

  getEnablePassword(): { value: string; algo: 'plain' | 'type-7' } | null { return this._enablePassword; }
  _setEnablePassword(value: string, algo: 'plain' | 'type-7'): void {
    this._enablePassword = value === '' ? null : { value, algo };
  }

  /**
   * `line console 0` / `privilege level N` — le niveau auquel une
   * session ouverte sur la console commence.
   *
   * Il vit sur l'EQUIPEMENT et non sur le shell, comme celui des vty :
   * `createVtyShell()` construit un shell neuf par session, si bien que
   * le reglage tape depuis une session SSH se rangeait sur le shell de
   * cette session et disparaissait avec elle — la console n'en savait
   * rien.
   */
  private _consoleLinePrivilege: number | null = null;

  getConsoleLinePrivilege(): number | null { return this._consoleLinePrivilege; }
  _setConsoleLinePrivilege(level: number | null): void {
    this._consoleLinePrivilege = level;
  }

  // Per-level `enable secret level N` / `enable password level N` (N != 15
  // — level 15 always uses the fields above, matching real IOS where the
  // bare/unqualified form and `level 15` are the same thing).
  private _enableSecretLevels: Map<number, { value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' }> = new Map();
  private _enablePasswordLevels: Map<number, { value: string; algo: 'plain' | 'type-7' }> = new Map();

  getEnableSecretForLevel(level: number): { value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' } | null {
    if (level === 15) return this.getEnableSecret();
    return this._enableSecretLevels.get(level) ?? null;
  }
  _setEnableSecretForLevel(level: number, value: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7'): void {
    if (level === 15) { this._setEnableSecret(value, algo); return; }
    if (value === '') this._enableSecretLevels.delete(level);
    else this._enableSecretLevels.set(level, { value, algo });
  }

  getEnablePasswordForLevel(level: number): { value: string; algo: 'plain' | 'type-7' } | null {
    if (level === 15) return this.getEnablePassword();
    return this._enablePasswordLevels.get(level) ?? null;
  }
  _setEnablePasswordForLevel(level: number, value: string, algo: 'plain' | 'type-7'): void {
    if (level === 15) { this._setEnablePassword(value, algo); return; }
    if (value === '') this._enablePasswordLevels.delete(level);
    else this._enablePasswordLevels.set(level, { value, algo });
  }

  /** All configured per-level (non-15) enable password entries — used by `show running-config`. */
  listEnablePasswordLevels(): ReadonlyArray<{ level: number; value: string; algo: 'plain' | 'type-7' }> {
    return [...this._enablePasswordLevels.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, v]) => ({ level, ...v }));
  }
  /** All configured per-level (non-15) enable secret entries — used by `show running-config`. */
  /**
   * Les drapeaux `service X` de la machine (`password-encryption`,
   * `timestamps`, …).
   *
   * Ils vivaient sur `Router` seul, si bien que
   * `service password-encryption` sur un Catalyst etait acceptee, sans
   * magasin et sans effet : le mot de passe de ligne restait en clair
   * dans la configuration, c'est-a-dire que la commande ne faisait rien
   * de ce qu'elle promet sur la seule chose qu'elle existe pour couvrir.
   * Le secret `enable`, lui, vit deja ici — les deux appartiennent au
   * meme fait.
   */
  private readonly _serviceFlags: Map<string, boolean> = new Map();

  getServiceFlags(): ReadonlyMap<string, boolean> { return this._serviceFlags; }
  _setServiceFlag(name: string, on: boolean): void { this._serviceFlags.set(name, on); }

  listEnableSecretLevels(): ReadonlyArray<{ level: number; value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' }> {
    return [...this._enableSecretLevels.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, v]) => ({ level, ...v }));
  }

  getUptimeMs(): number { return Math.max(0, Date.now() - this.bootedAtMs); }
  getBootedAtMs(): number { return this.bootedAtMs; }

  /** Optional bus override (Phase 2 of the reactive refactor). */
  private busOverride: IEventBus | null = null;

  /** This machine's internal bus (lazy) — see refactor-frame-only.md. */
  private machineBus: EventBus | null = null;
  private linkLayer: LinkLayer | null = null;
  private readonly captureTap = new TapPoint();

  constructor(deviceType: DeviceType, name: string, x: number = 0, y: number = 0) {
    this.id = generateId();
    this.deviceType = deviceType;
    this.name = typeof name === 'string' ? name : String(name);
    this.hostname = this.name;
    this.x = x;
    this.y = y;
    EquipmentRegistry.getInstance().register(this);
  }

  /** Inject a custom bus (test-only / multi-topology scenarios). */
  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
    for (const port of this.ports.values()) port.setEventBus(this.getBus());
    EquipmentRegistry.getInstance().notifyDeviceChanged();
  }

  getBus(): IEventBus {
    if (this.busOverride) return this.busOverride;
    if (!this.machineBus) this.machineBus = new EventBus();
    return this.machineBus;
  }

  getLinkLayer(): LinkLayer {
    if (!this.linkLayer) {
      this.linkLayer = new LinkLayer({
        getPort: (name) => this.getPort(name),
        transmit: (iface, frame) => this.sendFrame(iface, frame),
        ownsLocalUnicast: (iface, destination) =>
          this.ownsLocalUnicast(iface, destination),
      });
    }
    return this.linkLayer;
  }

  protected ownsLocalUnicast(_iface: string, _destination: MACAddress): boolean {
    return false;
  }

  attachCapture(tap: FrameTap, iface?: string): DetachTap {
    return this.captureTap.attach((tapped) => {
      if (iface !== undefined && tapped.iface !== iface) return;
      tap(tapped);
    });
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

  clearBootShown(): void { this._bootShown = false; }

  powerOn(): void {
    const wasOn = this.isPoweredOn;
    this.isPoweredOn = true;
    if (!wasOn) {
      // A real power-cycle resets the "boot already rendered" flag so the
      // very next terminal opens at boot-banner stage.
      this._bootShown = false;
    }
    Logger.info(this.id, 'equipment:power', `${this.name}: powered ON`);
    for (const port of this.ports.values()) port.setDevicePowered(true);
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
    for (const port of this.ports.values()) port.setDevicePowered(false);
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
    port.setOwner(this);
    port.setEventBus(this.getBus());
    port.onFrame((portName, frame) => {
      if (!this.isPoweredOn) {
        Logger.warn(this.id, 'equipment:frame-dropped', `${this.name}: powered off, dropping frame on ${portName}`);
        return;
      }
      this.handleFrame(portName, frame);
    });
    port.attachTap((tapped) => {
      this.captureTap.emit(tapped.iface, tapped.direction, tapped.frame);
    });
    this.ports.set(port.getName(), port);
  }

  /**
   * Send a frame out of a specific port
   */
  /**
   * Which member of an aggregate actually carries a frame handed to the
   * logical interface. `undefined` means the name is not an aggregate;
   * `null` means it is one with no usable member, so the frame is lost
   * rather than leaving through a port that has no wire.
   */
  protected aggregateMemberFor(
    _portName: string, _frame: EthernetFrame,
  ): string | null | undefined {
    return undefined;
  }

  /** The logical interface a frame arriving on a member belongs to. */
  protected aggregateIngressPort(_portName: string): string | undefined {
    return undefined;
  }

  sendFrame(portName: string, frame: EthernetFrame): boolean {
    const member = this.aggregateMemberFor(portName, frame);
    if (member === null) return false;
    if (member !== undefined) return this.sendFrame(member, frame);
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
