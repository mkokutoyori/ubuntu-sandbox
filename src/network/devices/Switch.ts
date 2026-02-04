/**
 * Switch - Layer 2 switching device
 *
 * Learns MAC addresses from incoming frames and forwards frames
 * to the correct port. Unknown unicast and broadcast frames are
 * flooded to all ports except the source.
 *
 * Communication flow:
 *   Frame arrives on portX → Switch learns srcMAC on portX
 *   → If dstMAC in MAC table → forward to that port
 *   → If dstMAC unknown or broadcast → flood to all ports except portX
 */

import { Equipment } from '../equipment/Equipment';
import { Port } from '../hardware/Port';
import { EthernetFrame, DeviceType, MACAddress } from '../core/types';
import { Logger } from '../core/Logger';

interface MACTableEntry {
  port: string;
  timestamp: number;
}

export class Switch extends Equipment {
  private macTable: Map<string, MACTableEntry> = new Map();
  private macAgingTime: number = 300_000; // 5 minutes

  constructor(type: DeviceType, name: string, portCount: number = 8, x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts(portCount);
  }

  private createPorts(count: number): void {
    for (let i = 0; i < count; i++) {
      const portName = this.deviceType.includes('cisco')
        ? `GigabitEthernet0/${i}`
        : `eth${i}`;
      this.addPort(new Port(portName, 'ethernet'));
    }
  }

  // ─── MAC Table ─────────────────────────────────────────────────

  getMACTable(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [mac, entry] of this.macTable) {
      result.set(mac, entry.port);
    }
    return result;
  }

  clearMACTable(): void {
    this.macTable.clear();
  }

  // ─── Frame Handling ────────────────────────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const srcMAC = frame.srcMAC.toString();
    const dstMAC = frame.dstMAC.toString();

    // Learn source MAC
    this.macTable.set(srcMAC, { port: portName, timestamp: Date.now() });
    Logger.debug(this.id, 'switch:mac-learn', `${this.name}: learned ${srcMAC} on ${portName}`);

    // Forward decision
    if (frame.dstMAC.isBroadcast()) {
      // Broadcast: flood to all ports except source
      Logger.debug(this.id, 'switch:flood-broadcast', `${this.name}: flooding broadcast from ${portName}`);
      this.floodFrame(portName, frame);
    } else {
      const entry = this.macTable.get(dstMAC);
      if (entry) {
        // Known unicast: forward to specific port
        Logger.debug(this.id, 'switch:forward', `${this.name}: forwarding to ${entry.port} (${dstMAC})`);
        this.sendFrame(entry.port, frame);
      } else {
        // Unknown unicast: flood
        Logger.debug(this.id, 'switch:flood-unknown', `${this.name}: flooding unknown ${dstMAC} from ${portName}`);
        this.floodFrame(portName, frame);
      }
    }
  }

  /**
   * Flood frame to all ports except the source port
   */
  private floodFrame(exceptPort: string, frame: EthernetFrame): void {
    for (const [portName] of this.ports) {
      if (portName !== exceptPort) {
        this.sendFrame(portName, frame);
      }
    }
  }

  // ─── Terminal (switches don't have full CLI yet) ───────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    return `${this.hostname}> ${command}\n% Command not implemented yet`;
  }
}
