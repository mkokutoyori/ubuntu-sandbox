/**
 * CiscoRouter - Cisco IOS Router specialization
 *
 * Extends abstract Router with Cisco-specific:
 *   - Port naming: GigabitEthernet0/X
 *   - CLI shell: CiscoIOSShell
 *   - Boot sequence: Cisco IOS bootstrap
 */

import { Router } from './Router';
import type { IRouterShell } from './shells/IRouterShell';
import { CiscoIOSShell } from './shells/CiscoIOSShell';
import {
  showVersion,
  showInterfacesStatus,
  showRunningConfig,
  showIpIntBrief,
} from './shells/cisco/CiscoShowCommands';

export class CiscoRouter extends Router {
  constructor(name: string = 'Router', x: number = 0, y: number = 0) {
    super('router-cisco', name, x, y);
  }

  protected getVendorPortName(index: number): string {
    return `GigabitEthernet0/${index}`;
  }

  protected sshVendorTag(): 'cisco' { return 'cisco'; }

  protected createShell(): IRouterShell {
    return new CiscoIOSShell();
  }

  /** Synchronous IOS exec whitelist consumed by the SSH cross-platform dispatch. */
  override runSshCommandSync(
    _user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    const cmd = command.trim();
    if (!cmd) return { output: '', exitCode: 0 };

    // `show version` — model + IOS banner.
    if (/^show\s+version\s*$/i.test(cmd)) {
      return { output: `${showVersion(this)}\n`, exitCode: 0 };
    }
    if (/^show\s+logging\s*$/i.test(cmd)) {
      const audit = this.getSecurityAuditLog();
      const formatted = audit.format();
      const header = 'Syslog logging: enabled (0 messages dropped, 0 flushes, 0 overruns, xml disabled, filtering disabled)\nConsole logging: level debugging, 0 messages logged, xml disabled\nMonitor logging: level debugging, 0 messages logged, xml disabled\nBuffer logging: level debugging, 0 messages logged, xml disabled\n\nLog Buffer (4096 bytes):\n';
      return { output: `${header}${formatted}\n`, exitCode: 0 };
    }
    if (/^show\s+privilege\s*$/i.test(cmd)) {
      return { output: 'Current privilege level is 15\n', exitCode: 0 };
    }
    if (/^show\s+users?\s*$/i.test(cmd)) {
      return { output: `${this.getSshSessionRegistry().formatShowUsers()}\n`, exitCode: 0 };
    }
    // `show interfaces status` — link state per port.
    if (/^show\s+int(?:erfaces)?\s+status\s*$/i.test(cmd)) {
      return { output: `${showInterfacesStatus(this)}\n`, exitCode: 0 };
    }
    // `show ip interface brief`.
    if (/^show\s+ip\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${showIpIntBrief(this)}\n`, exitCode: 0 };
    }
    // `show running-config [ | include … ]` — pipe filter supported.
    const runMatch = /^show\s+run(?:ning-config)?(?:\s*\|\s*(include|exclude)\s+(.+))?$/i.exec(cmd);
    if (runMatch) {
      const base = showRunningConfig(this);
      const extra: string[] = this._listLocalUsers().map(u =>
        `username ${u.name} privilege ${u.privilege} secret 5 ${u.secret}`,
      );
      const blockCfg = this.getLoginBlockConfig();
      if (blockCfg) extra.push(`login block-for ${blockCfg.blockSeconds} attempts ${blockCfg.attempts} within ${blockCfg.withinSeconds}`);
      const full = extra.length > 0 ? `${base}\n${extra.join('\n')}` : base;
      if (!runMatch[1]) return { output: `${full}\n`, exitCode: 0 };
      const needle = runMatch[2].trim();
      const lines = full.split('\n');
      const filtered = runMatch[1].toLowerCase() === 'include'
        ? lines.filter(l => l.includes(needle))
        : lines.filter(l => !l.includes(needle));
      return { output: `${filtered.join('\n')}\n`, exitCode: 0 };
    }
    return null;
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig'));
    const faPorts = [...ports.keys()].filter(n => n.startsWith('Fast'));
    return [
      '',
      'System Bootstrap, Version 15.0(1r)M15, RELEASE SOFTWARE (fc1)',
      'Copyright (c) 2003-2025 by cisco Systems, Inc.',
      '',
      `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5, RELEASE SOFTWARE (fc1)`,
      'Technical Support: http://www.cisco.com/techsupport',
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      'Cisco C2911 (revision 1.0) with 524288K/65536K bytes of memory.',
      'Processor board ID FTX1234567A',
      `${giPorts.length} Gigabit Ethernet interfaces`,
      ...(faPorts.length > 0 ? [`${faPorts.length} FastEthernet interfaces`] : []),
      'DRAM configuration is 64 bits wide with parity enabled.',
      '256K bytes of non-volatile configuration memory.',
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      '--- System Configuration Dialog ---',
      '',
      'Press RETURN to get started.',
    ].join('\n');
  }
}
