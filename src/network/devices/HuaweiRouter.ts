/**
 * HuaweiRouter - Huawei VRP Router specialization
 *
 * Extends abstract Router with Huawei-specific:
 *   - Port naming: GE0/0/X
 *   - CLI shell: HuaweiVRPShell
 *   - Boot sequence: Huawei VRP bootstrap
 */

import { Router } from './Router';
import type { IRouterShell } from './shells/IRouterShell';
import { HuaweiVRPShell } from './shells/HuaweiVRPShell';
import {
  displayVersion,
  displayInterfaceBrief,
  displayCurrentConfig,
  displayIpIntBrief,
} from './shells/huawei/HuaweiDisplayCommands';

export class HuaweiRouter extends Router {
  constructor(name: string = 'Router', x: number = 0, y: number = 0) {
    super('router-huawei', name, x, y);
  }

  protected getVendorPortName(index: number): string {
    return `GE0/0/${index}`;
  }

  protected createShell(): IRouterShell {
    return new HuaweiVRPShell();
  }

  /** Synchronous VRP exec whitelist consumed by the SSH cross-platform dispatch. */
  override runSshCommandSync(
    _user: string,
    command: string,
  ): { output: string; exitCode: number } | null {
    const cmd = command.trim();
    if (!cmd) return { output: '', exitCode: 0 };

    if (/^display\s+version\s*$/i.test(cmd)) {
      return { output: `${displayVersion(this)}\n`, exitCode: 0 };
    }
    if (/^display\s+logbuffer\s*$/i.test(cmd)) {
      const audit = this.getSecurityAuditLog();
      const header = 'Logging buffer configuration and contents: enabled\nAllowed max buffer size : 1024\nActual buffer size : 1024\nChannel number : 4, Channel name : logbuffer\nDropped messages : 0\nOverwritten messages : 0\nCurrent messages : ' + audit.entries().length + '\n';
      return { output: `${header}${audit.format()}\n`, exitCode: 0 };
    }
    if (/^display\s+users\s*$/i.test(cmd)) {
      const users = this._listLocalUsers();
      const lines = ['  UI    Delay    Type     Network Address     AuthenStatus    AuthorcmdFlag'];
      for (const u of users) lines.push(`+ 129    00:00:00 SSH      10.0.0.1            pass            ${u.name}`);
      return { output: `${lines.join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+local-user\s*$/i.test(cmd)) {
      const users = this._listLocalUsers();
      return { output: `User-name              State   Type   Privilege\n${users.map(u => `${u.name.padEnd(22)} A       SSH    ${u.privilege}`).join('\n')}\n`, exitCode: 0 };
    }
    if (/^display\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${displayInterfaceBrief(this)}\n`, exitCode: 0 };
    }
    if (/^display\s+ip\s+int(?:erface)?\s+brief\s*$/i.test(cmd)) {
      return { output: `${displayIpIntBrief(this)}\n`, exitCode: 0 };
    }
    // `display current-configuration [ | include … ]` — synthesises a
    // VRP-style running config with the SSH-relevant directives that
    // were captured by the shell hooks.
    const dispMatch = /^display\s+current-configuration(?:\s*\|\s*(include|exclude)\s+(.+))?$/i.exec(cmd);
    if (dispMatch) {
      const base = displayCurrentConfig(this, false, false, new Set());
      const lines = base.split('\n');
      for (const u of this._listLocalUsers()) {
        lines.push(`local-user ${u.name} password cipher ${u.secret}`);
        lines.push(`local-user ${u.name} privilege level ${u.privilege}`);
      }
      // Append SSH-state directives so SSH-aware tests see them. Real
      // VRP emits "protocol inbound ssh" specifically when ssh is among
      // the permitted protocols (not just when 'all' is set), so the
      // grep-style assertions in operations notebooks keep working.
      if (this.sshServerEnabled) lines.push('stelnet server enable');
      if (this.vtyTransportInput === 'all' || this.vtyTransportInput === 'ssh') {
        lines.push('protocol inbound ssh');
      } else if (this.vtyTransportInput === 'telnet') {
        lines.push('protocol inbound telnet');
      } else if (this.vtyTransportInput === 'none') {
        lines.push('protocol inbound none');
      }
      const out = lines.join('\n');
      if (!dispMatch[1]) return { output: `${out}\n`, exitCode: 0 };
      const needle = dispMatch[2].trim();
      const filtered = dispMatch[1].toLowerCase() === 'include'
        ? lines.filter(l => l.includes(needle))
        : lines.filter(l => !l.includes(needle));
      return { output: `${filtered.join('\n')}\n`, exitCode: 0 };
    }
    return null;
  }

  getBootSequence(): string {
    const ports = this._getPortsInternal();
    return [
      '',
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      'BOARD TYPE:          AR2220',
      'BootROM Version:     1.0',
      '',
      `${ports.size} GigabitEthernet interfaces`,
      '',
      `Base ethernet MAC address: ${ports.values().next().value?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press any key to get started.',
    ].join('\n');
  }
}
