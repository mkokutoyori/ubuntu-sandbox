/**
 * Hub - Layer 1 repeater device
 *
 * A hub simply repeats every incoming frame to ALL other ports.
 * No MAC learning, no intelligence - just flooding.
 */

import { Equipment } from '../equipment/Equipment';
import { Port } from '../hardware/Port';
import { EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';

export class Hub extends Equipment {
  constructor(name: string, portCount: number = 8, x: number = 0, y: number = 0) {
    super('hub', name, x, y);
    this.createPorts(portCount);
  }

  private createPorts(count: number): void {
    for (let i = 0; i < count; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    Logger.debug(this.id, 'hub:repeat', `${this.name}: repeating frame from ${portName} to all other ports`);

    // Flood to all ports except source
    for (const [name] of this.ports) {
      if (name !== portName) {
        this.sendFrame(name, frame);
      }
    }
  }

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    return `${this.hostname}> % Hub has no CLI`;
  }
}
