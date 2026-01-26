/**
 * CiscoASA - Cisco Adaptive Security Appliance
 *
 * Cisco firewall with IOS-like CLI and security zones.
 */

import { Firewall } from './Firewall';
import { DeviceConfig, OSType } from './types';

type ConfigMode = 'user' | 'privileged' | 'config' | 'interface';

export class CiscoASA extends Firewall {
  private configMode: ConfigMode;
  private enableSecret: string;
  private currentInterface: string;
  private commandHistory: string[];

  constructor(config: DeviceConfig) {
    super(config);

    // Override type
    (this as any).type = 'cisco-asa';

    // Set default hostname
    this.setHostname(config.hostname || 'ASA');

    this.configMode = 'user';
    this.enableSecret = '';
    this.currentInterface = '';
    this.commandHistory = [];
  }

  /**
   * Get device type
   */
  public getType(): string {
    return 'cisco-asa';
  }

  /**
   * Get OS type - Cisco IOS for terminal
   */
  public getOSType(): OSType {
    return 'cisco-ios';
  }

  /**
   * Get boot sequence
   */
  public getBootSequence(): string {
    return `
CISCO SYSTEMS
Embedded BIOS Version 1.0(12)13 04/30/08 15:45:41.19

Low Memory: 632 KB
High Memory: 1024 MB
PCI Device Table.
Bus Dev Func VendID DevID Class              Irq
 00  00  00   8086   2578  Host Bridge
 00  01  00   8086   2579  PCI-to-PCI Bridge
 00  03  00   8086   25A1  PCI-to-PCI Bridge

Evaluating BIOS Options ...
Launch BIOS Extension to setup ROMMON

Cisco Systems ROMMON Version (1.0(12)13) #0: Thu Apr 30 15:39:49 PDT 2008

Platform ASA 5506-X with FirePOWER services

Use BREAK or ESC to interrupt boot.
Use SPACE to begin boot immediately.

Loading...
Ciscoasa#
`;
  }

  /**
   * Get prompt based on current mode
   */
  public getPrompt(): string {
    const hostname = this.getHostname();

    switch (this.configMode) {
      case 'user':
        return `${hostname}>`;
      case 'privileged':
        return `${hostname}#`;
      case 'config':
        return `${hostname}(config)#`;
      case 'interface':
        return `${hostname}(config-if)#`;
      default:
        return `${hostname}>`;
    }
  }

  /**
   * Execute command
   */
  public async executeCommand(command: string): Promise<string> {
    if (!this.isOnline()) {
      return 'Device is offline';
    }

    const cmd = command.trim().toLowerCase();

    if (cmd) {
      this.commandHistory.push(command);
    }

    // Mode transitions
    if (cmd === 'enable') {
      this.configMode = 'privileged';
      return '';
    }

    if (cmd === 'configure terminal' || cmd === 'conf t') {
      if (this.configMode === 'privileged') {
        this.configMode = 'config';
        return '';
      }
      return '% Invalid input';
    }

    if (cmd === 'exit') {
      if (this.configMode === 'interface') {
        this.configMode = 'config';
      } else if (this.configMode === 'config') {
        this.configMode = 'privileged';
      } else if (this.configMode === 'privileged') {
        this.configMode = 'user';
      } else {
        return 'Connection closed.';
      }
      return '';
    }

    if (cmd === 'end') {
      this.configMode = 'privileged';
      return '';
    }

    // Show commands
    if (cmd === 'show version') {
      return this.getVersionOutput();
    }

    if (cmd === 'show interface' || cmd === 'show int') {
      return this.getInterfaceOutput();
    }

    return '';
  }

  private getVersionOutput(): string {
    return `Cisco Adaptive Security Appliance Software Version 9.12(4)
Device Manager Version 7.12(2)

Compiled on Wed 18-Dec-19 09:09 PST by builders
System image file is "disk0:/asa9-12-4-smp-k8.bin"
Config file at boot was "startup-config"

${this.getHostname()} up 1 hour 23 mins

Hardware:   ASA 5506-X with FirePOWER services
Model Id:   ASA5506
`;
  }

  private getInterfaceOutput(): string {
    let output = '';
    for (const iface of this.getInterfaces()) {
      const zone = this.getZone(iface.getName()) || 'unassigned';
      output += `Interface ${iface.getName()} "${zone}", is up, line protocol is up\n`;
    }
    return output;
  }

  /**
   * Set enable secret
   */
  public setEnableSecret(secret: string): void {
    this.enableSecret = secret;
  }
}
