/**
 * ConnectionFactory - Factory for creating network connections
 *
 * Creates the appropriate connection type based on the connection type.
 * Implements the Factory Pattern for connection instantiation.
 *
 * @example
 * ```typescript
 * const connection = ConnectionFactory.create('ethernet', {
 *   id: 'conn-1',
 *   sourceDeviceId: 'pc1',
 *   sourceInterfaceId: 'eth0',
 *   targetDeviceId: 'sw1',
 *   targetInterfaceId: 'eth0'
 * });
 * ```
 */

import { ConnectionType } from '../devices/types';
import { BaseConnection, ConnectionConfig } from './BaseConnection';
import { EthernetConnection } from './EthernetConnection';
import { SerialConnection } from './SerialConnection';
import { ConsoleConnection } from './ConsoleConnection';

export class ConnectionFactory {
  /**
   * Creates a connection of the specified type
   *
   * @param type - Connection type
   * @param config - Connection configuration
   * @returns Concrete connection instance
   */
  public static create(type: ConnectionType, config: ConnectionConfig): BaseConnection {
    switch (type) {
      case 'ethernet':
        return new EthernetConnection(config);
      case 'serial':
        return new SerialConnection(config);
      case 'console':
        return new ConsoleConnection(config);
      default:
        // Default to Ethernet for unknown types
        return new EthernetConnection(config);
    }
  }

  /**
   * Creates an Ethernet connection with specific settings
   */
  public static createEthernet(config: ConnectionConfig): EthernetConnection {
    return new EthernetConnection(config);
  }

  /**
   * Creates a Serial connection with specific settings
   */
  public static createSerial(config: ConnectionConfig): SerialConnection {
    return new SerialConnection(config);
  }

  /**
   * Creates a Console connection with specific settings
   */
  public static createConsole(config: ConnectionConfig): ConsoleConnection {
    return new ConsoleConnection(config);
  }
}
