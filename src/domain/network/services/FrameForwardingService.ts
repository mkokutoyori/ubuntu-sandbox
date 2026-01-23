/**
 * FrameForwardingService - Layer 2 Frame Forwarding Logic
 *
 * Implements switch forwarding behavior:
 * - Unicast forwarding based on MAC table
 * - Broadcast/multicast flooding
 * - Source MAC learning
 * - Port filtering (don't forward back to source)
 *
 * Design Pattern: Service (DDD) + Strategy
 * - Stateless forwarding operations
 * - Integrates with MACTableService
 * - Implements switch learning behavior
 *
 * Features:
 * - Automatic source MAC learning
 * - Intelligent forwarding decisions
 * - Flood on unknown destination
 * - Port management
 * - Forwarding statistics
 *
 * @example
 * ```typescript
 * const macTable = new MACTableService();
 * const forwardingService = new FrameForwardingService(macTable);
 *
 * forwardingService.setPorts(['eth0', 'eth1', 'eth2']);
 *
 * // Forward frame
 * const decision = forwardingService.forward(frame, 'eth0');
 * // decision.action: 'forward', 'flood', or 'filter'
 * // decision.ports: list of ports to forward to
 * ```
 */

import { EthernetFrame } from '../entities/EthernetFrame';
import { MACTableService } from './MACTableService';

/**
 * Forwarding action types
 */
export type ForwardingAction = 'forward' | 'flood' | 'filter';

/**
 * Forwarding decision
 */
export interface ForwardingDecision {
  action: ForwardingAction;
  ports: string[];
  reason: string;
}

/**
 * Forwarding statistics
 */
export interface ForwardingStatistics {
  totalFrames: number;
  unicastFrames: number;
  broadcastFrames: number;
  multicastFrames: number;
  floodedFrames: number;
  filteredFrames: number;
}

/**
 * FrameForwardingService - Implements Layer 2 forwarding logic
 */
export class FrameForwardingService {
  private macTable: MACTableService;
  private ports: Set<string>;
  private statistics: ForwardingStatistics;

  constructor(macTable: MACTableService) {
    this.macTable = macTable;
    this.ports = new Set();
    this.statistics = {
      totalFrames: 0,
      unicastFrames: 0,
      broadcastFrames: 0,
      multicastFrames: 0,
      floodedFrames: 0,
      filteredFrames: 0
    };
  }

  /**
   * Forwards frame and makes forwarding decision
   * Automatically learns source MAC address
   *
   * @param frame - Ethernet frame to forward
   * @param ingressPort - Port where frame was received
   * @returns Forwarding decision (action, ports, reason)
   */
  public forward(frame: EthernetFrame, ingressPort: string): ForwardingDecision {
    this.statistics.totalFrames++;

    // Learn source MAC (unless broadcast/multicast)
    const sourceMAC = frame.getSourceMAC();
    if (!sourceMAC.isBroadcast() && !sourceMAC.isMulticast()) {
      this.macTable.learn(sourceMAC, ingressPort);
    }

    const destinationMAC = frame.getDestinationMAC();

    // Handle broadcast
    if (destinationMAC.isBroadcast()) {
      this.statistics.broadcastFrames++;
      return this.floodFrame(ingressPort, 'Broadcast frame');
    }

    // Handle multicast
    if (destinationMAC.isMulticast()) {
      this.statistics.multicastFrames++;
      return this.floodFrame(ingressPort, 'Multicast frame');
    }

    // Handle unicast
    this.statistics.unicastFrames++;
    return this.forwardUnicast(destinationMAC, ingressPort);
  }

  /**
   * Forwards unicast frame based on MAC table
   *
   * @param destinationMAC - Destination MAC address
   * @param ingressPort - Ingress port
   * @returns Forwarding decision
   */
  private forwardUnicast(
    destinationMAC: import('../value-objects/MACAddress').MACAddress,
    ingressPort: string
  ): ForwardingDecision {
    const destinationPort = this.macTable.lookup(destinationMAC);

    if (!destinationPort) {
      // MAC not in table - flood
      return this.floodFrame(ingressPort, 'MAC unknown - flooding');
    }

    // Check if destination is on same port (filter)
    if (destinationPort === ingressPort) {
      this.statistics.filteredFrames++;
      return {
        action: 'filter',
        ports: [],
        reason: 'Destination on same port as source'
      };
    }

    // Forward to specific port
    return {
      action: 'forward',
      ports: [destinationPort],
      reason: `MAC known on port ${destinationPort}`
    };
  }

  /**
   * Floods frame to all ports except ingress
   *
   * @param ingressPort - Port to exclude from flooding
   * @param reason - Reason for flooding
   * @returns Forwarding decision
   */
  private floodFrame(ingressPort: string, reason: string): ForwardingDecision {
    this.statistics.floodedFrames++;

    const floodPorts = Array.from(this.ports).filter(port => port !== ingressPort);

    return {
      action: 'flood',
      ports: floodPorts,
      reason
    };
  }

  /**
   * Sets available ports
   *
   * @param ports - Array of port names
   */
  public setPorts(ports: string[]): void {
    this.ports = new Set(ports);
  }

  /**
   * Adds a port
   *
   * @param port - Port name
   */
  public addPort(port: string): void {
    this.ports.add(port);
  }

  /**
   * Removes a port and clears its MAC table entries
   *
   * @param port - Port name
   */
  public removePort(port: string): void {
    this.ports.delete(port);
    this.macTable.removePort(port);
  }

  /**
   * Returns list of configured ports
   *
   * @returns Array of port names
   */
  public getPorts(): string[] {
    return Array.from(this.ports);
  }

  /**
   * Returns forwarding statistics
   *
   * @returns Forwarding statistics
   */
  public getStatistics(): Readonly<ForwardingStatistics> {
    return { ...this.statistics };
  }

  /**
   * Resets forwarding statistics
   */
  public resetStatistics(): void {
    this.statistics = {
      totalFrames: 0,
      unicastFrames: 0,
      broadcastFrames: 0,
      multicastFrames: 0,
      floodedFrames: 0,
      filteredFrames: 0
    };
  }
}
