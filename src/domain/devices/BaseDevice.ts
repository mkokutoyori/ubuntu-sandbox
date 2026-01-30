/**
 * BaseDevice - Abstract base class for all network devices
 *
 * Provides common functionality for all devices:
 * - Identification (ID, name)
 * - Port management
 * - Status management (online/offline)
 * - Metadata storage
 *
 * Design Pattern: Template Method
 * - Defines common structure
 * - Subclasses implement specific behavior
 *
 * @example
 * ```typescript
 * class Router extends BaseDevice {
 *   constructor(id: string, name: string) {
 *     super(id, name, 'router');
 *   }
 *
 *   powerOn(): void {
 *     this.status = 'online';
 *     this.initializeRoutingTable();
 *   }
 * }
 * ```
 */

/**
 * Device types (unified for both network simulation and UI)
 */
export type DeviceType =
  // Computers
  | 'pc'           // Generic PC
  | 'linux-pc'     // Linux PC (for UI/Terminal)
  | 'windows-pc'   // Windows PC (for UI/Terminal)
  | 'mac-pc'       // Mac PC

  // Servers
  | 'linux-server'    // Linux Server (Ubuntu/CentOS)
  | 'windows-server'  // Windows Server

  // Database Servers
  | 'db-mysql'      // MySQL Database
  | 'db-postgres'   // PostgreSQL Database
  | 'db-oracle'     // Oracle Database
  | 'db-sqlserver'  // SQL Server Database

  // Network Devices - Layer 2
  | 'switch'       // Generic Layer 2 switch
  | 'cisco-switch' // Cisco switch (for UI/Terminal)
  | 'switch-cisco' // Alias for cisco-switch
  | 'switch-huawei' // Huawei switch
  | 'switch-generic' // Generic switch
  | 'hub'          // Layer 1 hub

  // Network Devices - Layer 3
  | 'router'       // Generic Layer 3 router
  | 'cisco-router' // Cisco router (for UI/Terminal)
  | 'router-cisco' // Alias for cisco-router
  | 'router-huawei' // Huawei router
  | 'cisco-l3-switch' // Cisco Layer 3 switch (for UI/Terminal)
  | 'multilayer-switch' // Generic multilayer switch

  // Security Devices
  | 'firewall'     // Generic firewall
  | 'cisco-asa'    // Cisco ASA firewall
  | 'firewall-cisco' // Alias for cisco-asa
  | 'firewall-fortinet' // Fortinet firewall
  | 'firewall-paloalto' // Palo Alto firewall

  // Wireless Devices
  | 'access-point'       // Wireless Access Point
  | 'wireless-controller' // Wireless LAN Controller

  // Infrastructure
  | 'cloud'        // Cloud/Internet representation

  // End Devices
  | 'ip-phone'     // VoIP Phone
  | 'printer'      // Network Printer

  // Testing
  | 'test';        // Test device

/**
 * Device status
 */
export type DeviceStatus = 'online' | 'offline' | 'error';

/**
 * Device export format
 */
export interface DeviceJSON {
  id: string;
  name: string;
  type: DeviceType;
  status: DeviceStatus;
  ports: string[];
  metadata: Record<string, any>;
  hostname?: string;
  x?: number;
  y?: number;
}

/**
 * BaseDevice - Abstract base class for network devices
 */
export abstract class BaseDevice {
  protected readonly id: string;
  protected name: string;
  protected readonly type: DeviceType;
  protected status: DeviceStatus;
  protected ports: Set<string>;
  protected metadata: Map<string, any>;

  // UI properties
  protected hostname: string;
  protected x: number;
  protected y: number;

  constructor(id: string, name: string, type: DeviceType) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.status = 'offline';
    this.ports = new Set();
    this.metadata = new Map();

    // Initialize UI properties
    this.hostname = name;
    this.x = 0;
    this.y = 0;
  }

  /**
   * Powers on the device
   * Must be implemented by subclasses
   */
  public abstract powerOn(): void;

  /**
   * Powers off the device
   * Must be implemented by subclasses
   */
  public abstract powerOff(): void;

  /**
   * Resets the device
   * Must be implemented by subclasses
   */
  public abstract reset(): void;

  /**
   * Returns device ID
   */
  public getId(): string {
    return this.id;
  }

  /**
   * Returns device name
   */
  public getName(): string {
    return this.name;
  }

  /**
   * Sets device name
   */
  public setName(name: string): void {
    this.name = name;
  }

  /**
   * Returns device type
   */
  public getType(): DeviceType {
    return this.type;
  }

  /**
   * Alias for getType() for UI compatibility
   */
  public getDeviceType(): DeviceType {
    return this.type;
  }

  /**
   * Returns OS type for terminal emulation
   * Override in subclasses for specific OS types
   */
  public getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown' {
    return 'unknown';
  }

  /**
   * Executes a command on the device terminal
   * Override in subclasses for specific command handling
   * @param command - Command to execute
   * @returns Command output
   */
  public async executeCommand(command: string): Promise<string> {
    return `Command execution not supported for device type: ${this.type}`;
  }

  /**
   * Returns device status
   */
  public getStatus(): DeviceStatus {
    return this.status;
  }

  /**
   * Checks if device is online
   */
  public isOnline(): boolean {
    return this.status === 'online';
  }

  /**
   * Returns device hostname
   */
  public getHostname(): string {
    return this.hostname;
  }

  /**
   * Sets device hostname
   */
  public setHostname(hostname: string): void {
    this.hostname = hostname;
  }

  /**
   * Returns device position (for UI)
   */
  public getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /**
   * Sets device position (for UI)
   */
  public setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  /**
   * Alias for isOnline (for UI compatibility)
   */
  public getIsPoweredOn(): boolean {
    return this.isOnline();
  }

  /**
   * Toggles power state
   */
  public togglePower(): void {
    if (this.isOnline()) {
      this.powerOff();
    } else {
      this.powerOn();
    }
  }

  /**
   * Adds a port to the device
   *
   * @param portName - Name of the port (e.g., 'eth0', 'FastEthernet0/1')
   */
  public addPort(portName: string): void {
    this.ports.add(portName);
  }

  /**
   * Removes a port from the device
   *
   * @param portName - Name of the port to remove
   */
  public removePort(portName: string): void {
    this.ports.delete(portName);
  }

  /**
   * Checks if device has a port
   *
   * @param portName - Name of the port to check
   * @returns True if port exists
   */
  public hasPort(portName: string): boolean {
    return this.ports.has(portName);
  }

  /**
   * Returns list of all ports
   *
   * @returns Array of port names
   */
  public getPorts(): string[] {
    return Array.from(this.ports);
  }

  /**
   * Sets metadata value
   *
   * @param key - Metadata key
   * @param value - Metadata value
   */
  public setMetadata(key: string, value: any): void {
    this.metadata.set(key, value);
  }

  /**
   * Gets metadata value
   *
   * @param key - Metadata key
   * @returns Metadata value or undefined if not found
   */
  public getMetadata(key: string): any {
    return this.metadata.get(key);
  }

  /**
   * Returns all metadata
   *
   * @returns Object with all metadata
   */
  public getAllMetadata(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of this.metadata.entries()) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Exports device to JSON format
   *
   * @returns Device data as JSON
   */
  public toJSON(): DeviceJSON {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      ports: this.getPorts(),
      metadata: this.getAllMetadata(),
      hostname: this.hostname,
      x: this.x,
      y: this.y
    };
  }
}
