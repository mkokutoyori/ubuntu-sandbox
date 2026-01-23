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
 * Device types
 */
export type DeviceType = 'pc' | 'switch' | 'router' | 'hub' | 'test';

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

  constructor(id: string, name: string, type: DeviceType) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.status = 'offline';
    this.ports = new Set();
    this.metadata = new Map();
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
      metadata: this.getAllMetadata()
    };
  }
}
