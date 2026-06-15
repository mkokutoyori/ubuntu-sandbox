/**
 * CiscoSwitchShell - Cisco IOS CLI Engine for Switches
 *
 * Extends CiscoShellBase<Switch> to inherit shared execute loop, FSM,
 * help/tab-complete, and common commands (enable, configure, ARP, hostname).
 *
 * Switch-specific additions:
 *   - VLANs, switchport modes, trunk/access configuration
 *   - MAC address table, spanning tree
 *   - DHCP snooping
 *   - Interface ranges
 *
 * Modes (FSM States):
 *   user, privileged, config, config-if, config-vlan
 */

import { CiscoShellBase } from './CiscoShellBase';
import { CommandTrie } from './CommandTrie';
import type { ISwitchShell } from './ISwitchShell';
import type { Switch } from '../Switch';
import type { PromptMap } from './PromptBuilder';
import { CISCO_SWITCH_PROMPTS } from './PromptBuilder';
import { CLIStateMachine, CISCO_SWITCH_MODES } from './CLIStateMachine';
import { MACAddress } from '../../core/types';
import { renderSecretField, renderPasswordField } from './cisco/ciscoPasswordRender';
import { showInterface } from './cisco/CiscoShowCommands';

/** CLI Mode (FSM State) */
export type CLIMode =
  | 'user' | 'privileged' | 'config' | 'config-if' | 'config-vlan'
  | 'config-mst' | 'config-line' | 'config-acl';

export class CiscoSwitchShell extends CiscoShellBase<Switch> implements ISwitchShell {
  // ─── Switch-specific state ───────────────────────────────────────
  private selectedInterface: string | null = null;
  private selectedInterfaceRange: string[] = [];
  private selectedVlan: number | null = null;

  // ─── FSM (switch-specific mode hierarchy) ────────────────────────
  protected readonly fsm = new CLIStateMachine<CLIMode>('user', CISCO_SWITCH_MODES, 'user', 'privileged');

  // ─── Additional tries (beyond base's user/privileged/config/configIf) ─
  private configVlanTrie = new CommandTrie();
  private configMstTrie = new CommandTrie();

  // STP state (switch-only, L2)
  private stpMode = 'pvst';
  private ifStp = new Map<string, string[]>();
  private ifExtra = new Map<string, string[]>();
  private configAclTrie = new CommandTrie();
  private selectedAcl: string | null = null;
  private selectedArpAcl: string | null = null;
  private acls = new Map<string, string[]>();
  private debugFlags = new Set<string>();

  constructor() {
    super();
    this.initializeCommands();
  }

  // ─── ISwitchShell ────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    return this.executeOnDevice(sw, input) as string;
  }

  getPrompt(sw: Switch): string {
    return this.buildDevicePrompt(sw);
  }

  override getMode(): CLIMode { return this.mode as CLIMode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  getSelectedInterfaceRange(): string[] { return [...this.selectedInterfaceRange]; }

  // ─── Abstract Method Implementations ─────────────────────────────

  protected getPromptMap(): PromptMap { return CISCO_SWITCH_PROMPTS; }

  protected onSave(): string {
    return this.d().writeMemory();
  }

  protected getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user':        return this.userTrie;
      case 'privileged':  return this.privilegedTrie;
      case 'config':      return this.configTrie;
      case 'config-if':   return this.configIfTrie;
      case 'config-vlan': return this.configVlanTrie;
      case 'config-mst':  return this.configMstTrie;
      case 'config-line': return this.configLineTrie;
      case 'config-acl':  return this.configAclTrie;
      default:            return this.userTrie;
    }
  }

  protected clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedInterfaceRange') this.selectedInterfaceRange = [];
      if (f === 'selectedVlan') this.selectedVlan = null;
      if (f === 'selectedAcl') { this.selectedAcl = null; this.selectedArpAcl = null; }
    }
  }

  // ─── Switch-Specific Command Registration ─────────────────────────

  protected registerDeviceCommands(): void {
    // ── User mode ──
    this.registerUserCommands();

    // ── Privileged mode ──
    this.registerPrivilegedCommands();

    // ── Config mode ──
    this.registerConfigCommands();

    // ── Config-if mode ──
    this.registerConfigIfCommands();

    // ── Config-vlan mode ──
    this.configVlanTrie.registerGreedy('name', 'Set VLAN name', (args) => {
      if (!this.selectedVlan || args.length < 1) return '% Incomplete command.';
      const ok = this.d().renameVLAN(this.selectedVlan, args[0]);
      if (ok) this.d().getVtpAgent().onLocalVlanChange();
      return ok ? '' : '% VLAN not found';
    });

    // ── Spanning Tree (L2, switch-only) ──
    this.registerStpCommands();

    // ── ACL + DAI (switch-only; router has its own ACL impl) ──
    this.configTrie.registerGreedy('access-list', 'Numbered ACL entry', (args) => {
      const n = args[0] ?? '?';
      const l = this.acls.get(n) ?? [];
      l.push(`access-list ${args.join(' ')}`);
      this.acls.set(n, l);
      return '';
    });
    this.configTrie.registerGreedy('ip access-list', 'Named ACL', (args) => {
      // ip access-list {standard|extended} <name>
      const name = args[1] ?? args[0] ?? 'ACL';
      this.selectedAcl = name;
      if (!this.acls.has(name)) this.acls.set(name, []);
      this.mode = 'config-acl';
      return '';
    });
    this.registerDaiCommands();
    this.registerPortSecurityCommands();
    this.registerVtpCommands();
    this.registerUdldCommands();
    this.registerIgmpSnoopingCommands();
    for (const kw of ['permit', 'deny', 'remark', 'no', 'evaluate']) {
      this.configAclTrie.registerGreedy(kw, `ACL ${kw}`, (args) => {
        if (this.selectedArpAcl) {
          return this.handleArpAclLine(kw, args);
        }
        if (this.selectedAcl) {
          this.acls.get(this.selectedAcl)!.push(`${kw} ${args.join(' ')}`.trim());
        }
        return '';
      });
    }
    // numbered sequence entries (e.g. "10 permit ip any any")
    this.configAclTrie.registerGreedy('', 'Sequenced ACL entry', (args) => {
      if (this.selectedAcl && args.length) {
        this.acls.get(this.selectedAcl)!.push(args.join(' '));
      }
      return '';
    });
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.register('show ip interface brief', 'Display IP interface brief', () => {
        // L2 switch: only SVIs/mgmt carry IPs (none by default here).
        return [
          'Interface              IP-Address      OK? Method Status                Protocol',
          'Vlan1                  unassigned      YES unset  administratively down down',
        ].join('\n');
      });
      t.registerGreedy('show access-lists', 'Display ACLs', () => {
        if (this.acls.size === 0) return '';
        const out: string[] = [];
        for (const [k, rules] of this.acls) {
          out.push(/^\d+$/.test(k)
            ? `Standard IP access list ${k}` : `Extended IP access list ${k}`);
          for (const r of rules) out.push(`    ${r}`);
        }
        return out.join('\n');
      });
      t.registerGreedy('show port-security', 'Display port security', (args) => {
        if (args[0]?.toLowerCase() === 'interface' && args[1]) {
          return this.showPortSecurityInterface(this.d(), args.slice(1).join(' '));
        }
        if (args[0]?.toLowerCase() === 'address') {
          return this.showPortSecurityAddress(this.d());
        }
        return this.showPortSecurityOverview(this.d());
      });
    }
  }

  private registerDaiCommands(): void {
    const parseList = (spec: string): number[] => {
      const out: number[] = [];
      for (const part of spec.split(',')) {
        const m = part.match(/^(\d+)-(\d+)$/);
        if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); }
        else { const n = parseInt(part, 10); if (!isNaN(n)) out.push(n); }
      }
      return out;
    };

    // ── Global ── ip arp inspection vlan <list>
    this.configTrie.registerGreedy('ip arp inspection vlan', 'Enable DAI on VLAN(s)', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const cfg = this.d()._getArpInspectionConfig();
      for (const v of parseList(args.join(','))) cfg.vlans.add(v);
      return '';
    });
    this.configTrie.registerGreedy('no ip arp inspection vlan', 'Disable DAI on VLAN(s)', (args) => {
      const cfg = this.d()._getArpInspectionConfig();
      for (const v of parseList(args.join(','))) cfg.vlans.delete(v);
      return '';
    });
    this.configTrie.registerGreedy('ip arp inspection validate', 'Extra DAI checks', (args) => {
      const cfg = this.d()._getArpInspectionConfig();
      for (const tok of args) {
        const k = tok.toLowerCase();
        if (k === 'src-mac') cfg.validate.srcMac = true;
        else if (k === 'dst-mac') cfg.validate.dstMac = true;
        else if (k === 'ip') cfg.validate.ip = true;
      }
      return '';
    });
    this.configTrie.registerGreedy('no ip arp inspection validate', 'Clear DAI checks', (args) => {
      const cfg = this.d()._getArpInspectionConfig();
      if (args.length === 0) {
        cfg.validate.srcMac = false; cfg.validate.dstMac = false; cfg.validate.ip = false;
      } else for (const tok of args) {
        const k = tok.toLowerCase();
        if (k === 'src-mac') cfg.validate.srcMac = false;
        else if (k === 'dst-mac') cfg.validate.dstMac = false;
        else if (k === 'ip') cfg.validate.ip = false;
      }
      return '';
    });
    this.configTrie.registerGreedy('ip arp inspection filter', 'Apply ARP ACL to VLAN(s)', (args) => {
      // ip arp inspection filter <acl> vlan <list> [static]
      const aclName = args[0]; const vlanIdx = args.indexOf('vlan');
      if (!aclName || vlanIdx < 1) return '% Incomplete command.';
      const list = args[vlanIdx + 1];
      if (!list) return '% Incomplete command.';
      const isStatic = args[vlanIdx + 2]?.toLowerCase() === 'static';
      const cfg = this.d()._getArpInspectionConfig();
      for (const v of parseList(list)) cfg.vlanAclFilters.set(v, { aclName, staticMode: isStatic });
      return '';
    });
    this.configTrie.registerGreedy('errdisable recovery cause arp-inspection',
      'Auto-recover DAI err-disabled ports', () => {
        const cfg = this.d()._getArpInspectionConfig();
        if (cfg.errDisableRecoverySec <= 0) this.d()._setArpRecoverySec(30);
        return '';
      });
    this.configTrie.registerGreedy('errdisable recovery interval',
      'Auto-recovery interval (sec)', (args) => {
        const n = parseInt(args[0] ?? '', 10);
        if (!isNaN(n) && n > 0) this.d()._setArpRecoverySec(n);
        return '';
      });

    // ── arp access-list ──
    this.configTrie.registerGreedy('arp access-list', 'Define an ARP ACL', (args) => {
      const name = args[0]; if (!name) return '% Incomplete command.';
      const map = this.d()._getArpAccessLists();
      if (!map.has(name)) map.set(name, { name, entries: [] });
      this.selectedArpAcl = name;
      this.selectedAcl = null;
      this.mode = 'config-acl';
      return '';
    });

    // ── Interface ── trust + limit rate
    this.configIfTrie.register('ip arp inspection trust', 'Trust port for DAI', () => {
      const cfg = this.d()._getArpInspectionConfig();
      return this.applyToSelectedInterfaces(p => { cfg.trustedPorts.add(p); return ''; });
    });
    this.configIfTrie.register('no ip arp inspection trust', 'Untrust port for DAI', () => {
      const cfg = this.d()._getArpInspectionConfig();
      return this.applyToSelectedInterfaces(p => { cfg.trustedPorts.delete(p); return ''; });
    });
    this.configIfTrie.registerGreedy('ip arp inspection limit rate', 'Per-port pps cap', (args) => {
      const r = parseInt(args[0] ?? '', 10);
      if (isNaN(r) || r < 0) return '% Invalid rate value';
      const cfg = this.d()._getArpInspectionConfig();
      return this.applyToSelectedInterfaces(p => { cfg.rateLimits.set(p, r); return ''; });
    });

    // ── Show ──
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.registerGreedy('show dtp', 'Display DTP information', (args) => {
        const dtp = this.d().getDtpAgent();
        const ports = this.d().getPortNames();
        if (args[0]?.toLowerCase() === 'interface' && args[1]) {
          const name = this.resolveInterfaceName(args.slice(1).join(' ')) ?? args.slice(1).join(' ');
          if (!this.d().getPort(name)) return `% Invalid interface "${args.slice(1).join(' ')}"`;
          const s = dtp.getPortState(name);
          return [
            `DTP information for ${name}:`,
            `  TOS/TAS/TNS:                            ${s.operationalMode === 'trunk' ? 'TRUNK' : 'ACCESS'}/${this.dtpAdminLabel(s.adminMode)}/NONE`,
            `  TOT/TAT/TNT:                            ${s.trunkEncapsulation.toUpperCase()}/NEGOTIATE/NONE`,
            `  Neighbor address 1:                     ${s.peerMac ?? '000000000000'}`,
            `  Neighbor address 2:                     000000000000`,
            `  Hello timer expiration (sec/state):     0/RUNNING`,
            `  Access timer expiration (sec/state):    never/STOPPED`,
            `  Negotiation timer expiration (sec/st):  never/STOPPED`,
            `  Multidrop timer expiration (sec/state): never/STOPPED`,
            `  FSM state:                              S6:TRUNK`,
          ].join('\n');
        }
        const lines = ['Global DTP information', `  Sending DTP Hello packets every ${dtp.getConfig().helloSec} seconds`, '  Dynamic Trunk timeout is 300 seconds', ''];
        lines.push('Interface       Mode             Status         Negotiation');
        lines.push('--------------- ---------------- -------------- -----------');
        for (const p of ports) {
          const s = dtp.getPortState(p);
          lines.push(
            `${this.abbreviateInterface(p).padEnd(16)}${this.dtpAdminLabel(s.adminMode).padEnd(17)}` +
            `${s.operationalMode.padEnd(15)}${s.adminMode === 'nonegotiate' ? 'off' : 'on'}`,
          );
        }
        return lines.join('\n');
      });

      t.register('show ip arp inspection', 'Display DAI status', () => this.showArpInspection(this.d()));
      t.registerGreedy('show ip arp inspection vlan', 'Display DAI per VLAN', (args) =>
        this.showArpInspectionVlan(this.d(), args.join(',')));
      t.register('show ip arp inspection statistics', 'Display DAI counters', () =>
        this.showArpInspectionStats(this.d()));
      t.register('show ip arp inspection interfaces', 'Display DAI per interface', () =>
        this.showArpInspectionIfs(this.d()));
      t.register('show arp access-list', 'Display ARP ACLs', () => this.showArpAcls(this.d()));
      t.register('show errdisable recovery', 'Display errdisable recovery state', () => this.showErrdisableRecovery());
    }

    // ── clear / recovery ──
    this.privilegedTrie.register('clear ip arp inspection statistics',
      'Reset DAI counters', () => { this.d()._resetArpInspectionStats(); return ''; });
    this.privilegedTrie.registerGreedy('clear errdisable interface',
      'Recover an err-disabled port', (args) => {
        const portName = this.resolveInterfaceName(args.join(' ')) ?? args.join(' ');
        this.d()._clearArpInspectionErrDisable(portName);
        return '';
      });
    this.privilegedTrie.registerGreedy('clear spanning-tree detected-protocols',
      'Restart protocol migration', () => '');
    this.privilegedTrie.registerGreedy('clear spanning-tree counters',
      'Clear spanning-tree counters', () => '');
  }

  private handleArpAclLine(kw: string, args: string[]): string {
    if (!this.selectedArpAcl) return '';
    const map = this.d()._getArpAccessLists();
    const acl = map.get(this.selectedArpAcl);
    if (!acl) return '';
    if (kw === 'no') {
      const raw = args.join(' ');
      const idx = acl.entries.findIndex(e => e.raw === raw);
      if (idx >= 0) acl.entries.splice(idx, 1);
      return '';
    }
    if (kw !== 'permit' && kw !== 'deny') return '';
    // Syntax: permit ip {host <ip>|any} mac {host <mac>|any}
    let i = 0;
    let senderIp: string | null = null;
    let senderMac: string | null = null;
    if (args[i]?.toLowerCase() === 'ip') {
      i++;
      if (args[i]?.toLowerCase() === 'host') { senderIp = args[i + 1] ?? null; i += 2; }
      else if (args[i]?.toLowerCase() === 'any') { i++; }
    }
    if (args[i]?.toLowerCase() === 'mac') {
      i++;
      if (args[i]?.toLowerCase() === 'host') { senderMac = (args[i + 1] ?? '').toLowerCase() || null; i += 2; }
      else if (args[i]?.toLowerCase() === 'any') { i++; }
    }
    acl.entries.push({
      action: kw, senderIp, senderMac,
      raw: `${kw} ${args.join(' ')}`.trim(),
    });
    return '';
  }

  private registerPortSecurityCommands(): void {
    const parseMac = (s: string): MACAddress | null => {
      try { return new MACAddress(s); } catch { return null; }
    };

    // ── enable / disable ──
    this.configIfTrie.register('switchport port-security', 'Enable port-security', () =>
      this.applyToSelectedInterfaces(p => {
        const port = this.d().getPort(p); if (port) port.getPortSecurity().enable();
        return '';
      }));
    this.configIfTrie.register('no switchport port-security', 'Disable port-security', () =>
      this.applyToSelectedInterfaces(p => {
        const port = this.d().getPort(p); if (port) port.getPortSecurity().disable();
        return '';
      }));

    // ── maximum ──
    this.configIfTrie.registerGreedy('switchport port-security maximum',
      'Max secure MAC addresses', (args) => {
        const n = parseInt(args[0] ?? '', 10);
        if (isNaN(n) || n < 1) return '% Invalid maximum value';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setMaxMACAddresses(n);
          return '';
        });
      });

    // ── violation mode ──
    this.configIfTrie.registerGreedy('switchport port-security violation',
      'Violation mode', (args) => {
        const m = (args[0] ?? '').toLowerCase();
        if (m !== 'shutdown' && m !== 'restrict' && m !== 'protect') return '% Invalid mode';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p);
          if (port) port.getPortSecurity().setViolationMode(m as 'shutdown' | 'restrict' | 'protect');
          return '';
        });
      });

    // ── mac-address (static + sticky toggle + sticky <mac>) ──
    this.configIfTrie.registerGreedy('switchport port-security mac-address',
      'Configure secure MAC', (args) => {
        if (args.length === 0) return '% Incomplete command.';
        if (args[0].toLowerCase() === 'sticky') {
          if (args.length === 1) {
            return this.applyToSelectedInterfaces(p => {
              const port = this.d().getPort(p); if (port) port.getPortSecurity().enableSticky();
              return '';
            });
          }
          const mac = parseMac(args[1]); if (!mac) return `% Invalid MAC "${args[1]}"`;
          return this.applyToSelectedInterfaces(p => {
            const port = this.d().getPort(p); if (port) port.getPortSecurity().addStickyMAC(mac);
            return '';
          });
        }
        const mac = parseMac(args[0]); if (!mac) return `% Invalid MAC "${args[0]}"`;
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().addStaticMAC(mac);
          return '';
        });
      });
    this.configIfTrie.registerGreedy('no switchport port-security mac-address',
      'Remove secure MAC', (args) => {
        if (args.length === 0) return '% Incomplete command.';
        if (args[0].toLowerCase() === 'sticky' && args.length === 1) {
          return this.applyToSelectedInterfaces(p => {
            const port = this.d().getPort(p); if (port) port.getPortSecurity().disableSticky();
            return '';
          });
        }
        const target = args[args.length - 1];
        const mac = parseMac(target); if (!mac) return `% Invalid MAC "${target}"`;
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().removeMAC(mac);
          return '';
        });
      });

    // ── aging ──
    this.configIfTrie.registerGreedy('switchport port-security aging time',
      'Aging window (minutes)', (args) => {
        const n = parseInt(args[0] ?? '', 10);
        if (isNaN(n) || n < 0) return '% Invalid aging time';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingTimeMin(n);
          return '';
        });
      });
    this.configIfTrie.registerGreedy('switchport port-security aging type',
      'Aging strategy', (args) => {
        const t = (args[0] ?? '').toLowerCase();
        if (t !== 'absolute' && t !== 'inactivity') return '% Invalid aging type';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingType(t as 'absolute' | 'inactivity');
          return '';
        });
      });
    this.configIfTrie.register('switchport port-security aging static',
      'Apply aging to static entries', () =>
        this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingStatic(true);
          return '';
        }));
    this.configIfTrie.register('no switchport port-security aging static',
      'Exempt static entries from aging', () =>
        this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingStatic(false);
          return '';
        }));

    // ── errdisable recovery ──
    this.configTrie.register('errdisable recovery cause psecure-violation',
      'Auto-recover ports err-disabled by port-security', () => {
        if (this.d()._getPsecRecoverySec() <= 0) this.d()._setPsecRecoverySec(30);
        return '';
      });

    // ── clear ──
    this.privilegedTrie.registerGreedy('clear port-security',
      'Clear secure MAC entries', (args) => {
        const kind = (args[0] ?? '').toLowerCase();
        if (!['all', 'configured', 'dynamic', 'sticky'].includes(kind)) {
          return '% Usage: clear port-security {all|configured|dynamic|sticky} [interface <if>]';
        }
        const ifIdx = args.findIndex(a => a.toLowerCase() === 'interface');
        const portFilter = ifIdx >= 0
          ? this.resolveInterfaceName(args.slice(ifIdx + 1).join(' '))
          : null;
        for (const [name, p] of this.d()._getPortsInternal()) {
          if (portFilter && name !== portFilter) continue;
          const sec = p.getPortSecurity();
          if (kind === 'all') sec.clearAll();
          else if (kind === 'dynamic') sec.clearDynamic();
          else if (kind === 'sticky') sec.clearSticky();
          else if (kind === 'configured') { sec.clearSticky(); sec.clearDynamic(); }
        }
        return '';
      });
    this.privilegedTrie.registerGreedy('clear errdisable interface',
      'Recover an err-disabled port', (args) => {
        const portName = this.resolveInterfaceName(args.join(' ')) ?? args.join(' ');
        const cleared = this.d()._clearArpInspectionErrDisable(portName)
          || this.d()._clearPsecErrDisable(portName);
        return cleared ? '' : '';
      });
  }

  // ─── Port-Security Display ────────────────────────────────────────

  private renderPortSecurityLines(port: import('../../hardware/Port').Port): string[] {
    const sec = port.getPortSecurity();
    if (!sec.isEnabled()) return [];
    const out: string[] = ['switchport port-security'];
    if (sec.getMaxMACAddresses() !== 1) {
      out.push(`switchport port-security maximum ${sec.getMaxMACAddresses()}`);
    }
    if (sec.getViolationMode() !== 'shutdown') {
      out.push(`switchport port-security violation ${sec.getViolationMode()}`);
    }
    if (sec.isStickyEnabled()) {
      out.push('switchport port-security mac-address sticky');
    }
    for (const e of sec.getEntries()) {
      if (e.type === 'sticky') {
        out.push(`switchport port-security mac-address sticky ${this.formatMacCisco(e.mac)}`);
      } else if (e.type === 'static') {
        out.push(`switchport port-security mac-address ${this.formatMacCisco(e.mac)}`);
      }
    }
    if (sec.getAgingTimeMin() > 0) {
      out.push(`switchport port-security aging time ${sec.getAgingTimeMin()}`);
      if (sec.getAgingType() !== 'absolute') {
        out.push(`switchport port-security aging type ${sec.getAgingType()}`);
      }
      if (sec.getAgingStatic()) out.push('switchport port-security aging static');
    }
    return out;
  }

  private dtpAdminLabel(m: import('../../dtp/types').DtpAdminMode): string {
    switch (m) {
      case 'access': return 'ACCESS';
      case 'trunk': return 'TRUNK';
      case 'dynamic-auto': return 'DYN-AUTO';
      case 'dynamic-desirable': return 'DYN-DESIRABLE';
      case 'nonegotiate': return 'TRUNK';
    }
  }

  private formatMacCisco(mac: MACAddress): string {
    const hex = mac.toString().replace(/[:-]/g, '');
    return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`;
  }

  private showPortSecurityOverview(sw: Switch): string {
    const lines = [
      'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
      '             (Count)        (Count)      (Count)',
      '------------------------------------------------------------------------------',
    ];
    for (const [name, port] of sw._getPortsInternal()) {
      const sec = port.getPortSecurity();
      if (!sec.isEnabled()) continue;
      lines.push(
        `${this.abbreviateInterface(name).padEnd(12)} ` +
        `${String(sec.getMaxMACAddresses()).padEnd(14)} ` +
        `${String(sec.getEntries().length).padEnd(12)} ` +
        `${String(sec.getViolationCount()).padEnd(18)} ` +
        sec.getViolationMode(),
      );
    }
    return lines.join('\n');
  }

  private showPortSecurityInterface(sw: Switch, ifaceArg: string): string {
    const name = this.resolveInterfaceName(ifaceArg) ?? ifaceArg;
    const port = sw.getPort(name);
    if (!port) return `% Invalid interface "${ifaceArg}"`;
    const sec = port.getPortSecurity();
    const errd = sw._getPsecErrDisabledPorts().has(name);
    const status = !sec.isEnabled() ? 'Disabled' :
                   errd ? 'Secure-shutdown' :
                   port.getIsUp() ? 'Secure-up' : 'Secure-down';
    return [
      `Port Security              : ${sec.isEnabled() ? 'Enabled' : 'Disabled'}`,
      `Port Status                : ${status}`,
      `Violation Mode             : ${sec.getViolationMode().charAt(0).toUpperCase() + sec.getViolationMode().slice(1)}`,
      `Aging Time                 : ${sec.getAgingTimeMin()} mins`,
      `Aging Type                 : ${sec.getAgingType().charAt(0).toUpperCase() + sec.getAgingType().slice(1)}`,
      `SecureStatic Address Aging : ${sec.getAgingStatic() ? 'Enabled' : 'Disabled'}`,
      `Maximum MAC Addresses      : ${sec.getMaxMACAddresses()}`,
      `Total MAC Addresses        : ${sec.getEntries().length}`,
      `Configured MAC Addresses   : ${sec.getEntries().filter(e => e.type === 'static').length}`,
      `Sticky MAC Addresses       : ${sec.getEntries().filter(e => e.type === 'sticky').length}`,
      `Last Source Address:Vlan   : ${sec.getEntries().length > 0
          ? `${this.formatMacCisco(sec.getEntries()[sec.getEntries().length - 1].mac)}:${sec.getEntries()[sec.getEntries().length - 1].vlan}`
          : '0000.0000.0000:0'}`,
      `Security Violation Count   : ${sec.getViolationCount()}`,
    ].join('\n');
  }

  private showPortSecurityAddress(sw: Switch): string {
    const lines = [
      '          Secure Mac Address Table',
      '------------------------------------------------------------------------',
      'Vlan    Mac Address       Type                          Ports   Remaining Age',
      '----    -----------       ----                          -----   -------------',
    ];
    let n = 0;
    for (const [name, port] of sw._getPortsInternal()) {
      const sec = port.getPortSecurity();
      if (!sec.isEnabled()) continue;
      for (const e of sec.getEntries()) {
        const typeStr = e.type === 'static' ? 'SecureConfigured'
          : e.type === 'sticky' ? 'SecureSticky' : 'SecureDynamic';
        lines.push(
          `${String(e.vlan).padEnd(8)}${this.formatMacCisco(e.mac).padEnd(18)}` +
          `${typeStr.padEnd(30)}${this.abbreviateInterface(name).padEnd(8)}` +
          `${sec.getAgingTimeMin() > 0 ? `${sec.getAgingTimeMin()}m` : '-'}`,
        );
        n++;
      }
    }
    lines.push('');
    lines.push(`Total Addresses: ${n}`);
    return lines.join('\n');
  }

  private registerVtpCommands(): void {
    this.configTrie.registerGreedy('vtp domain', 'Set VTP domain', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.d().getVtpAgent().setDomain(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('vtp mode', 'Set VTP mode', (args) => {
      const m = (args[0] ?? '').toLowerCase();
      if (m !== 'server' && m !== 'client' && m !== 'transparent' && m !== 'off') {
        return '% Invalid VTP mode';
      }
      this.d().getVtpAgent().setMode(m);
      return '';
    });
    this.configTrie.registerGreedy('vtp password', 'Set VTP password', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.d().getVtpAgent().setPassword(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('vtp version', 'Set VTP version', (args) => {
      const v = parseInt(args[0] ?? '', 10);
      if (v !== 1 && v !== 2 && v !== 3) return '% Invalid VTP version';
      this.d().getVtpAgent().setVersion(v as 1 | 2 | 3);
      return '';
    });
    this.configTrie.register('vtp pruning', 'Enable VTP pruning', () => {
      this.d().getVtpAgent().setPruning(true);
      return '';
    });
    this.configTrie.register('no vtp pruning', 'Disable VTP pruning', () => {
      this.d().getVtpAgent().setPruning(false);
      return '';
    });

    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.register('show vtp status', 'Display VTP status', () => {
        const cfg = this.d().getVtpAgent().getConfig();
        const numVlans = this.d().getVLANs().size;
        return [
          `VTP Version capable             : 1 to ${cfg.version}`,
          `VTP version running             : ${cfg.version}`,
          `VTP Domain Name                 : ${cfg.domain || '<empty>'}`,
          `VTP Pruning Mode                : ${cfg.pruning ? 'Enabled' : 'Disabled'}`,
          `VTP Traps Generation            : Disabled`,
          `Device ID                       : ${cfg.updaterMac}`,
          `Configuration last modified by  : ${cfg.updaterMac}`,
          `Local updater ID is ${cfg.updaterMac}`,
          ``,
          `Feature VLAN:`,
          `--------------`,
          `VTP Operating Mode              : ${cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1)}`,
          `Maximum VLANs supported locally : 1005`,
          `Number of existing VLANs        : ${numVlans}`,
          `Configuration Revision          : ${cfg.revision}`,
        ].join('\n');
      });
      t.register('show vtp counters', 'Display VTP counters', () => {
        return 'VTP statistics:\nSummary advertisements received    : 0\nSubset advertisements received     : 0\nRequest advertisements received    : 0\nSummary advertisements transmitted : 0\nSubset advertisements transmitted  : 0\nRequest advertisements transmitted : 0\nNumber of config revision errors   : 0\nNumber of config digest errors     : 0';
      });
    }
  }

  private registerUdldCommands(): void {
    this.configTrie.registerGreedy('udld', 'UDLD global configuration', (args) => {
      const a = (args[0] ?? '').toLowerCase();
      const agent = this.d().getUdldAgent();
      if (a === 'enable') { agent.setGlobalMode('normal'); return ''; }
      if (a === 'aggressive') { agent.setGlobalMode('aggressive'); return ''; }
      if (a === 'message' && args[1] === 'time') {
        const n = parseInt(args[2] ?? '', 10);
        if (!Number.isNaN(n)) {
          const c = agent.getConfig() as { helloIntervalSec: number };
          c.helloIntervalSec = n;
        }
        return '';
      }
      return '';
    });
    this.configTrie.registerGreedy('no udld', 'Disable UDLD globally', () => {
      this.d().getUdldAgent().setGlobalMode('disabled');
      return '';
    });
    this.configIfTrie.registerGreedy('udld port', 'UDLD per-port configuration', (args) => {
      const ports = this.selectedPortsForConfigIf();
      const m = (args[0] ?? '').toLowerCase();
      const mode = m === 'aggressive' ? 'aggressive' : 'normal';
      for (const p of ports) this.d().getUdldAgent().setPortMode(p, mode);
      return '';
    });
    this.configIfTrie.register('no udld port', 'Disable UDLD on this port', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.d().getUdldAgent().setPortMode(p, 'disabled');
      return '';
    });
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.registerGreedy('show udld', 'Display UDLD state', (args) => {
        const agent = this.d().getUdldAgent();
        const target = args[0];
        const ports = target
          ? agent.listPorts().filter(p => p.port === target || p.port.endsWith(target))
          : agent.listPorts();
        if (ports.length === 0) return '';
        const lines: string[] = [];
        for (const rt of ports) {
          lines.push(`Interface ${rt.port}`);
          lines.push(`---`);
          lines.push(`Port enable administrative configuration setting: ${rt.mode === 'disabled' ? 'Disabled' : 'Enabled'}`);
          lines.push(`Port enable operational state: ${rt.mode === 'disabled' ? 'Disabled' : 'Enabled / in ' + rt.mode + ' mode'}`);
          lines.push(`Current bidirectional state: ${rt.state === 'bidirectional' ? 'Bidirectional' : rt.state}`);
          lines.push(`Current operational state: ${rt.state}`);
          const neighbors = agent.getNeighborsFor(rt.port);
          lines.push(`Message interval: ${agent.getConfig().helloIntervalSec}`);
          lines.push(`Time out interval: ${agent.getConfig().messageTimeoutSec}`);
          for (const n of neighbors) {
            lines.push(`Entry 1`);
            lines.push(`Expiration time: ${agent.getConfig().messageTimeoutSec}`);
            lines.push(`Device ID: ${n.remoteDeviceId}`);
            lines.push(`Current neighbor state: ${rt.state}`);
            lines.push(`Device name: ${n.remoteHostname}`);
            lines.push(`Port ID: ${n.remotePortId}`);
            lines.push(`Neighbor echo 1 device: ${n.echo[0]?.deviceId ?? 'none'}`);
            lines.push(`Neighbor echo 1 port: ${n.echo[0]?.portId ?? 'none'}`);
            lines.push(`Message interval: ${n.helloIntervalSec}`);
          }
        }
        return lines.join('\n');
      });
    }
  }

  private registerIgmpSnoopingCommands(): void {
    this.configTrie.registerGreedy('ip igmp snooping', 'IGMP snooping config', (args) => {
      const agent = this.d().getIgmpSnoopingAgent();
      const a = args.map(s => s.toLowerCase());
      if (a.length === 0) { agent.setEnabled(true); return ''; }
      if (a[0] === 'vlan' && a[1]) {
        const vlan = parseInt(a[1], 10);
        if (!Number.isNaN(vlan)) {
          if (a[2] === 'immediate-leave') { agent.setImmediateLeave(vlan, true); return ''; }
          agent.setVlanEnabled(vlan, true);
        }
        return '';
      }
      return '';
    });
    this.configTrie.registerGreedy('no ip igmp snooping', 'Disable IGMP snooping', (args) => {
      const agent = this.d().getIgmpSnoopingAgent();
      const a = args.map(s => s.toLowerCase());
      if (a.length === 0) { agent.setEnabled(false); return ''; }
      if (a[0] === 'vlan' && a[1]) {
        const vlan = parseInt(a[1], 10);
        if (!Number.isNaN(vlan)) {
          if (a[2] === 'immediate-leave') { agent.setImmediateLeave(vlan, false); return ''; }
          agent.setVlanEnabled(vlan, false);
        }
      }
      return '';
    });
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.registerGreedy('show ip igmp snooping', 'Display IGMP snooping state', (args) => {
        const agent = this.d().getIgmpSnoopingAgent();
        const cfg = agent.getConfig();
        if (args.includes('groups')) {
          let vlanFilter: number | undefined;
          const vi = args.indexOf('vlan');
          if (vi >= 0 && args[vi + 1]) {
            const n = parseInt(args[vi + 1], 10);
            if (!Number.isNaN(n)) vlanFilter = n;
          }
          const rows = ['Vlan      Group               Type    Version  Port List'];
          for (const { vlan, group } of agent.listGroups(vlanFilter)) {
            const ports = Array.from(group.members.keys()).join(', ');
            rows.push(
              `${String(vlan).padEnd(10)}${group.groupAddress.padEnd(20)}igmp    v2       ${ports}`);
          }
          return rows.join('\n');
        }
        if (args.includes('mrouter')) {
          const rows = ['Vlan    ports'];
          for (const v of agent.listVlans()) {
            rows.push(`${String(v.vlan).padEnd(8)}${Array.from(v.routerPorts).join(', ')}`);
          }
          return rows.join('\n');
        }
        const lines: string[] = [];
        lines.push(`Global IGMP Snooping configuration:`);
        lines.push(`-----------------------------------------`);
        lines.push(`IGMP snooping              : ${cfg.enabled ? 'Enabled' : 'Disabled'}`);
        lines.push(`IGMPv3 snooping            : Disabled`);
        lines.push(`Report suppression         : Enabled`);
        lines.push(`TCN solicit query          : Disabled`);
        lines.push(`Robustness variable        : 2`);
        lines.push(`Last member query count    : 2`);
        lines.push(`Last member query interval : 1000`);
        lines.push(``);
        lines.push(`Vlan ${[...agent.listVlans()].map(v => v.vlan).join(',') || '<none>'}:`);
        return lines.join('\n');
      });
    }
  }

  private registerStpCommands(): void {
    this.configTrie.register('spanning-tree mst configuration',
      'Enter MST configuration sub-mode', () => {
        this.mode = 'config-mst';
        return '';
      });
    // Global: every other `spanning-tree …` is accepted (mode/priority/
    // root/extend/portfast/loopguard/…). Track the mode for `show`.
    this.configTrie.registerGreedy('spanning-tree', 'Spanning Tree configuration', (args) => {
      if (args[0]?.toLowerCase() === 'mode' && args[1]) {
        this.stpMode = args[1];
        const m = args[1].toLowerCase();
        this.d().getStpAgent().setMode(
          m === 'rapid-pvst' || m === 'mst' ? 'rstp' : 'stp');
      }
      if (args[0]?.toLowerCase() === 'vlan' && args[2]) {
        const knob = args[2].toLowerCase();
        const n = parseInt(args[3] ?? '', 10);
        const agent = this.d().getStpAgent();
        if (knob === 'priority' && !isNaN(n)) agent.setBridgePriority(n);
        else if (knob === 'hello-time' && !isNaN(n)) agent.setHelloSec(n);
        else if (knob === 'max-age' && !isNaN(n)) agent.setMaxAgeSec(n);
        else if (knob === 'forward-time' && !isNaN(n)) agent.setForwardDelaySec(n);
      }
      if (args[0]?.toLowerCase() === 'priority') {
        const n = parseInt(args[1] ?? '', 10);
        if (!isNaN(n)) this.d().getStpAgent().setBridgePriority(n);
      }
      if (args[0]?.toLowerCase() === 'portfast'
          && args[1]?.toLowerCase() === 'bpduguard'
          && args[2]?.toLowerCase() === 'default') {
        this.d().getStpAgent().setBpduGuardGlobal(true);
      }
      return '';
    });
    this.configTrie.registerGreedy('no spanning-tree', 'Disable spanning-tree', (args) => {
      if (args[0]?.toLowerCase() === 'vlan' && args[1]) {
        this.d().getStpAgent().setEnabled(false);
      }
      return '';
    });

    // Interface: spanning-tree portfast/bpduguard/cost/… (tracked).
    this.configIfTrie.registerGreedy('spanning-tree', 'Interface STP configuration', (args) => {
      const ifs = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      const a = args.map(s => s.toLowerCase());
      const agent = this.d().getStpAgent();
      const head = a[0] ?? '';
      const isGuardRoot = head === 'guard' && a[1] === 'root';
      const isBpduGuard = head === 'bpduguard';
      const isPortFast = head === 'portfast';
      for (const i of ifs) {
        if (isPortFast) {
          agent.setPortFast(i, a[1] !== 'disable');
        } else if (isBpduGuard) {
          agent.setPortBpduGuard(i, a[1] === 'enable');
        } else if (isGuardRoot) {
          agent.setPortRootGuard(i, true);
        }
        const l = this.ifStp.get(i) ?? [];
        l.push(`spanning-tree ${args.join(' ')}`.trim());
        this.ifStp.set(i, l);
      }
      return '';
    });
    this.configIfTrie.registerGreedy('no spanning-tree', 'Disable interface STP knob', (args) => {
      const ifs = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      const a = args.map(s => s.toLowerCase());
      const agent = this.d().getStpAgent();
      for (const i of ifs) {
        if (a[0] === 'portfast') agent.setPortFast(i, false);
        else if (a[0] === 'bpduguard') agent.setPortBpduGuard(i, false);
        else if (a[0] === 'guard') agent.setPortRootGuard(i, false);
      }
      return '';
    });

    // config-mst sub-mode
    this.configMstTrie.registerGreedy('name', 'Set MST region name', (a) => {
      this.stpAgentOf(this.d())?.setMstName(a.join(' ')); return '';
    });
    this.configMstTrie.registerGreedy('revision', 'Set MST revision', (a) => {
      const n = parseInt(a[0], 10); if (!isNaN(n)) this.stpAgentOf(this.d())?.setMstRevision(n); return '';
    });
    this.configMstTrie.registerGreedy('instance', 'Map VLANs to an MST instance', (a) => {
      const id = parseInt(a[0], 10);
      if (!isNaN(id)) this.stpAgentOf(this.d())?.mapMstInstance(id, a.slice(1).join(' '));
      return '';
    });
    this.configMstTrie.register('show current', 'Show pending MST config', () =>
      this.showMstConfig());
    // The base redirects `show …` in config modes to the privileged
    // trie, so `show current` must also resolve there.
    this.privilegedTrie.register('show current', 'Show pending MST config', () =>
      this.showMstConfig());
    this.configMstTrie.registerGreedy('no', 'Negate MST option', (args) => {
      const head = args[0]?.toLowerCase();
      const ag = this.stpAgentOf(this.d());
      if (head === 'name') ag?.setMstName('');
      else if (head === 'revision') ag?.setMstRevision(0);
      else if (head === 'instance' && args[1]) {
        const inst = parseInt(args[1], 10);
        if (!isNaN(inst)) ag?.unmapMstInstance(inst);
      }
      return '';
    });
    this.configMstTrie.registerGreedy('abort', 'Abort MST changes', () => {
      this.mode = 'config'; return '';
    });

    // show spanning-tree summary | mst configuration | interface <if>
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.register('show spanning-tree summary', 'STP summary', () => {
        const sw = this.d();
        const agent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
        const stpStates = sw._getSTPStates();
        const isRoot = agent?.isRoot() ?? false;
        const rootForVlan = isRoot ? 'VLAN0001' : 'none';
        let blocking = 0, listening = 0, learning = 0, forwarding = 0;
        for (const state of stpStates.values()) {
          if (state === 'blocking') blocking++;
          else if (state === 'listening') listening++;
          else if (state === 'learning') learning++;
          else if (state === 'forwarding') forwarding++;
        }
        const total = blocking + listening + learning + forwarding;
        return [
          `Switch is in ${this.stpMode} mode`,
          `Root bridge for: ${rootForVlan}`,
          `Extended system ID           is enabled`,
          `Portfast Default             is disabled`,
          ``,
          `Name                   Blocking Listening Learning Forwarding STP Active`,
          `---------------------- -------- --------- -------- ---------- ----------`,
          `VLAN0001               ${String(blocking).padStart(8)} ${String(listening).padStart(9)} ${String(learning).padStart(8)} ${String(forwarding).padStart(10)} ${String(total).padStart(10)}`,
        ].join('\n');
      });
      t.register('show spanning-tree mst configuration', 'MST region config', () =>
        this.showMstConfig());
      t.registerGreedy('show spanning-tree interface', 'STP for an interface', (a) => {
        const name = this.resolvePortName(a.join(' ')) ?? a.join(' ');
        const lines = this.ifStp.get(name) ?? [];
        return `${name}\n` + (lines.length ? lines.join('\n') : '  (default STP settings)');
      });
      t.register('show spanning-tree', 'Display spanning tree state', () => this.showSpanningTree(this.d()));
      t.register('show spanning-tree detail', 'Detailed STP state', () => this.showStpDetail(this.d()));
      t.register('show spanning-tree root', 'STP root bridge info', () => this.showStpRoot(this.d()));
      t.register('show spanning-tree bridge', 'STP local bridge info', () => this.showStpBridge(this.d()));
      t.register('show spanning-tree blockedports', 'STP blocked ports', () => this.showStpBlockedPorts(this.d()));
      t.registerGreedy('show spanning-tree vlan', 'STP for a VLAN', (a) => {
        const id = parseInt(a[0], 10);
        if (isNaN(id)) return this.showSpanningTree(this.d());
        if (a[1]?.toLowerCase() === 'detail') return this.showStpDetail(this.d(), id);
        if (a[1]?.toLowerCase() === 'bridge') return this.showStpBridge(this.d(), id);
        if (a[1]?.toLowerCase() === 'root') return this.showStpRoot(this.d(), id);
        return this.showSpanningTree(this.d(), id);
      });
      t.register('show spanning-tree summary totals', 'STP summary totals', () =>
        `Switch is in ${this.stpMode} mode\n` +
        `Root bridge for: ${this.stpAgentOf(this.d())?.isRoot() ? 'VLAN0001' : 'none'}\n` +
        `                     Blocking Listening Learning Forwarding STP Active\n` +
        `-------------------- -------- --------- -------- ---------- ----------\n` +
        `1 vlan               ${this.stpSummaryCounts(this.d())}`);
      t.register('show spanning-tree inconsistentports', 'STP inconsistent ports', () => {
        const agent = this.stpAgentOf(this.d());
        const bad: string[] = [];
        for (const [portName] of this.d()._getSTPStates()) {
          if (agent?.isRootInconsistent(portName)) bad.push(this.abbreviateInterface(portName));
        }
        return [
          'Name                 Interface                Inconsistency',
          '-------------------- ------------------------ ------------------',
          ...bad.map((p) => `VLAN0001             ${p.padEnd(24)} Root Inconsistent`),
          '',
          `Number of inconsistent ports (segments) in the system : ${bad.length}`,
        ].join('\n');
      });
      t.register('show debugging', 'Display active debugging', () => {
        if (this.debugFlags.size === 0) return 'No debugging is enabled';
        return [...this.debugFlags].sort().join('\n');
      });
      t.registerGreedy('debug spanning-tree', 'Enable STP debugging', (a) => {
        const what = a.join(' ') || 'all';
        this.debugFlags.add(`Spanning Tree ${what} debugging is on`);
        return `Spanning Tree ${what} debugging is on`;
      });
      t.registerGreedy('debug', 'Enable debugging', (a) => {
        const what = a.join(' ') || 'all';
        this.debugFlags.add(`${what} debugging is on`);
        return `${what} debugging is on`;
      });
      t.registerGreedy('undebug', 'Disable debugging', () => {
        this.debugFlags.clear();
        return 'All possible debugging has been turned off';
      });
      t.register('no debug all', 'Disable debugging', () => {
        this.debugFlags.clear();
        return 'All possible debugging has been turned off';
      });
    }
  }

  private showMstConfig(): string {
    const region = this.stpAgentOf(this.d())?.getMstRegion();
    const instances = region?.instances ?? new Map<number, string>();
    const ml: string[] = [
      'Name      [' + (region?.name ?? '') + ']',
      'Revision  ' + (region?.revision ?? 0) + '     Instances configured ' +
        (instances.size + 1),
      '-------------------------------------------------------------',
      'Instance  Vlans mapped',
      '--------  -------------------------------------------------',
      '0         1-4094',
    ];
    for (const [id, v] of instances) ml.push(`${String(id).padEnd(10)}${v}`);
    return ml.join('\n');
  }

  private resolvePortName(input: string): string | null {
    const names = this.d().getPortNames();
    const lower = input.replace(/\s+/g, '').toLowerCase();
    for (const n of names) if (n.toLowerCase() === lower) return n;
    return null;
  }

  // ─── User Commands ────────────────────────────────────────────────

  private registerUserCommands(): void {
    this.userTrie.register('show version', 'Display system hardware and software status', () => {
      return `Cisco IOS Software, C2960 Software\n${this.d().getHostname()} uptime is 0 days, 0 hours`;
    });

    this.userTrie.register('show ip dhcp snooping', 'Display DHCP snooping configuration', () => {
      return this.showDHCPSnooping(this.d());
    });

    this.userTrie.register('show ip dhcp snooping binding', 'Display DHCP snooping binding table', () => {
      return this.showDHCPSnoopingBinding(this.d());
    });

    this.userTrie.register('show logging', 'Display syslog messages', () => {
      return this.showLogging(this.d());
    });

    this.userTrie.registerGreedy('ping', 'Send echo messages', () => {
      return `Type escape sequence to abort.\n% Ping not yet implemented on switch.`;
    });
  }

  // ─── Privileged Commands ──────────────────────────────────────────

  private registerPrivilegedCommands(): void {
    this.privilegedTrie.registerGreedy('show mac address-table', 'Display MAC address table', (args) => {
      const full = this.showMACAddressTable(this.d());
      if (args[0]?.toLowerCase() === 'vlan' && args[1]) {
        const lines = full.split('\n');
        return [lines[0] ?? '', ...lines.filter(l =>
          new RegExp(`\\b${args[1]}\\b`).test(l))].join('\n');
      }
      return full;
    });

    this.privilegedTrie.registerGreedy('clear mac address-table', 'Clear MAC address table entries', (args) => {
      const a = args.map(x => x.toLowerCase());
      let i = 0;
      if (a[i] === 'dynamic') i++;
      const filter: { vlan?: number; port?: string } = {};
      if (a[i] === 'vlan' && a[i + 1] && /^\d+$/.test(a[i + 1])) {
        filter.vlan = parseInt(a[i + 1], 10);
      } else if (a[i] === 'interface' && args[i + 1]) {
        const pn = this.resolveInterfaceName(args[i + 1]);
        if (!pn) return `% Invalid interface name "${args[i + 1]}"`;
        filter.port = pn;
      }
      this.d().clearDynamicMACEntries(Object.keys(filter).length ? filter : undefined);
      return '';
    });

    this.privilegedTrie.registerGreedy('show interfaces trunk', 'Display trunk ports', () => {
      const rows = ['Port      Mode  Encapsulation  Status   Native vlan'];
      for (const p of this.d().getPortNames()) {
        const c = this.d().getSwitchportConfig(p);
        if (c && c.mode === 'trunk') {
          rows.push(`${p.padEnd(10)}on    802.1q         trunking ${c.trunkNativeVlan}`);
        }
      }
      return rows.join('\n');
    });

    this.privilegedTrie.registerGreedy('show etherchannel', 'Display EtherChannel', (args) => {
      const lacp = this.d().getLacpAgent();
      const groups = lacp.getAllGroups();
      if (args[0]?.toLowerCase() === 'summary' || args.length === 0) {
        const lines = [
          'Flags:  D - down        P - bundled in port-channel',
          '        I - stand-alone s - suspended',
          '        H - Hot-standby (LACP only)',
          '        s - suspended',
          `Number of channel-groups in use: ${groups.length}`,
          'Group  Port-channel  Protocol    Ports',
          '------+-------------+-----------+-----------------------------------------',
        ];
        for (const g of groups) {
          const protocol = g.members.every(m => m.mode === 'on') ? '-' : 'LACP';
          const portList = g.members.map(m => {
            const flag = m.bundled ? 'P' : m.state === 'standalone' ? 'I' : 's';
            return `${this.abbreviateInterface(m.portName)}(${flag})`;
          }).join(' ');
          lines.push(`${String(g.id).padEnd(7)}${g.name.padEnd(14)}${protocol.padEnd(12)}${portList}`);
        }
        return lines.join('\n');
      }
      if (args[0]?.toLowerCase() === 'detail') {
        const out: string[] = [];
        for (const g of groups) {
          out.push(`Group: ${g.id}`);
          out.push(`Port-channels in the group: 1`);
          out.push(`Port-channel: ${g.name}`);
          out.push(`Number of ports = ${g.members.length}`);
          for (const m of g.members) {
            const port = this.d().getPort(m.portName);
            out.push(`  Port: ${m.portName}`);
            out.push(`    Status: ${m.bundled ? 'bundled' : m.state}`);
            out.push(`    Mode: ${m.mode}`);
            out.push(`    Partner: ${m.partner?.systemId ?? 'none'}`);
            out.push(`    Link: ${port?.getIsUp() ? 'up' : 'down'}`);
          }
        }
        return out.length > 0 ? out.join('\n') : 'No EtherChannel groups configured';
      }
      return 'EtherChannel: no detail';
    });

    this.privilegedTrie.registerGreedy('show interfaces', 'Display interface information', (args) => {
      if (args.length === 0) return this.showAllInterfacesDetail();
      const last = args[args.length - 1].toLowerCase();
      if (last === 'switchport') {
        const target = args.slice(0, -1).join(' ');
        if (!target) {
          return this.d().getPortNames().map((n) => this.showSwitchportDetail(n)).join('\n\n');
        }
        const name = this.resolveInterfaceName(target) ?? target;
        return this.showSwitchportDetail(name);
      }
      if (last === 'counters') {
        const target = args.slice(0, -1).join(' ');
        const name = target ? this.resolveInterfaceName(target) : null;
        return this.showInterfacesCounters(name);
      }
      if (last === 'description') return this.showInterfacesDescriptionTable();
      if (args.length === 1 && last === 'status') return this.showInterfacesStatus(this.d());
      const name = this.resolveInterfaceName(args.join(' '));
      if (name && this.d().getPort(name)) return showInterface(this.d(), name);
      return `% Invalid input detected at '^' marker.\nshow interfaces ${args.join(' ')}\n                ^`;
    });

    this.privilegedTrie.register('show vlan brief', 'Display VLAN summary', () => {
      return this.showVlanBrief(this.d());
    });

    this.privilegedTrie.register('show vlan', 'Display VLAN information', () => {
      return this.showVlanBrief(this.d());
    });

    this.privilegedTrie.registerGreedy('show vlan id', 'Display a VLAN by id', (args) => {
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return '% Invalid VLAN id';
      return this.showVlanBrief(this.d(), { id });
    });

    this.privilegedTrie.registerGreedy('show vlan name', 'Display a VLAN by name', (args) => {
      if (!args[0]) return '% Incomplete command.';
      return this.showVlanBrief(this.d(), { name: args[0] });
    });

    this.privilegedTrie.registerGreedy('show running-config interface', 'Display interface running config', (args) => {
      const name = this.resolveInterfaceName(args.join(' '))
        ?? this.virtualInterfaceName(args.join(' ')) ?? args.join(' ');
      const cfg = this.d().getSwitchportConfig(name);
      const out = [`interface ${name}`];
      if (cfg) {
        out.push(cfg.mode === 'trunk' ? ' switchport mode trunk' : ' switchport mode access');
        if (cfg.mode !== 'trunk' && cfg.accessVlan !== 1) {
          out.push(` switchport access vlan ${cfg.accessVlan}`);
        }
      }
      for (const l of this.ifExtra.get(name) ?? []) out.push(` ${l}`);
      for (const l of this.ifStp.get(name) ?? []) out.push(` ${l}`);
      const port = this.d().getPort(name);
      if (port) for (const l of this.renderPortSecurityLines(port)) out.push(` ${l}`);
      const cdpA = (this.d() as unknown as { getCdpAgent?: () => import('../../cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
      if (cdpA) for (const l of cdpA.runningConfigInterfaceLines(name)) out.push(` ${l}`);
      const lldpA = (this.d() as unknown as { getLldpAgent?: () => import('../../lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
      if (lldpA) for (const l of lldpA.runningConfigInterfaceLines(name)) out.push(` ${l}`);
      out.push('end');
      return out.join('\n');
    });

    this.privilegedTrie.register('show running-config', 'Display current running configuration', () => {
      return this.buildRunningConfig(this.d());
    });

    this.privilegedTrie.register('show startup-config', 'Display startup configuration', () => {
      const startup = this.d().getStartupConfig();
      return startup ? `Startup config (serialized):\n${startup}` : 'startup-config is not present';
    });

    this.privilegedTrie.register('write', 'Save running-config to startup-config', () => {
      return this.d().writeMemory();
    });

    this.privilegedTrie.register('show version', 'Display system information', () => {
      return `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2\n${this.d().getHostname()} uptime is 0 days, 0 hours`;
    });

    this.privilegedTrie.register('show ip dhcp snooping', 'Display DHCP snooping configuration', () => {
      return this.showDHCPSnooping(this.d());
    });

    this.privilegedTrie.register('show ip dhcp snooping binding', 'Display DHCP snooping binding table', () => {
      return this.showDHCPSnoopingBinding(this.d());
    });

    this.privilegedTrie.register('show logging', 'Display syslog messages', () => {
      return this.showLogging(this.d());
    });
  }

  // ─── Config Commands ──────────────────────────────────────────────

  private registerConfigCommands(): void {
    // hostname is handled by base class (registerCommonConfigCommands)

    this.configTrie.registerGreedy('vlan', 'VLAN configuration', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      // Accept a single id, a comma list (100,200,300) and ranges
      // (30-35) — IOS creates them all; only a single id enters
      // config-vlan.
      const spec = args.join('');
      const ids: number[] = [];
      for (const part of spec.split(',')) {
        const m = part.match(/^(\d+)-(\d+)$/);
        if (m) {
          for (let i = +m[1]; i <= +m[2]; i++) ids.push(i);
        } else {
          const n = parseInt(part, 10);
          if (!isNaN(n)) ids.push(n);
        }
      }
      if (ids.length === 0 || ids.some(i => i < 1 || i > 4094)) {
        return '% Invalid VLAN ID';
      }
      let created = false;
      for (const id of ids) if (!this.d().getVLAN(id)) { this.d().createVLAN(id); created = true; }
      if (created) this.d().getVtpAgent().onLocalVlanChange();
      if (ids.length === 1) {
        this.selectedVlan = ids[0];
        this.mode = 'config-vlan';
      }
      return '';
    });

    this.configTrie.registerGreedy('no vlan', 'Delete a VLAN', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return '% Invalid VLAN ID';
      if (id === 1) return '% Default VLAN 1 may not be deleted.';
      const ok = this.d().deleteVLAN(id);
      if (ok) this.d().getVtpAgent().onLocalVlanChange();
      return ok ? '' : `% VLAN ${id} not found.`;
    });

    this.configTrie.registerGreedy('interface', 'Select an interface to configure', (args) => {
      if (args.length < 1) return '% Incomplete command.';

      if (args[0].toLowerCase() === 'range') {
        return this.handleInterfaceRange(args.slice(1));
      }

      const virt = this.virtualInterfaceName(args.join(' '));
      if (virt) {
        this.selectedInterface = virt;
        this.selectedInterfaceRange = [virt];
        this.mode = 'config-if';
        return '';
      }

      const portName = this.resolveInterfaceName(args[0]);
      if (!portName || !this.d().getPort(portName)) {
        return `% Invalid interface name "${args[0]}"`;
      }
      this.selectedInterface = portName;
      this.selectedInterfaceRange = [portName];
      this.mode = 'config-if';
      return '';
    });

    this.configTrie.registerGreedy('mac address-table aging-time', 'Set MAC address aging time', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const seconds = parseInt(args[0], 10);
      if (isNaN(seconds) || seconds < 0) return '% Invalid aging time';
      this.d().setMACAgingTime(seconds);
      return '';
    });

    this.configTrie.register('no shutdown', 'Enable interface', () => '');

    this.configTrie.register('ip dhcp snooping', 'Enable DHCP snooping globally', () => {
      this.d()._getDHCPSnoopingConfig().enabled = true;
      return '';
    });

    this.configTrie.registerGreedy('ip dhcp snooping vlan', 'Enable DHCP snooping on VLANs', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const cfg = this.d()._getDHCPSnoopingConfig();
      const parts = args[0].split(',');
      for (const part of parts) {
        if (part.includes('-')) {
          const [s, e] = part.split('-').map(Number);
          if (!isNaN(s) && !isNaN(e)) {
            for (let i = s; i <= e; i++) cfg.vlans.add(i);
          }
        } else {
          const v = parseInt(part, 10);
          if (!isNaN(v)) cfg.vlans.add(v);
        }
      }
      return '';
    });

    this.configTrie.register('ip dhcp snooping verify mac-address', 'Enable MAC address verification', () => {
      this.d()._getDHCPSnoopingConfig().verifyMac = true;
      return '';
    });

  }

  // ─── Config-if Commands ───────────────────────────────────────────

  private registerConfigIfCommands(): void {
    // Cisco IOS: `interface X` from config-if switches to the new interface
    this.configIfTrie.registerGreedy('interface', 'Select an interface to configure', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (args[0].toLowerCase() === 'range') {
        return this.handleInterfaceRange(args.slice(1));
      }
      const virt = this.virtualInterfaceName(args.join(' '));
      if (virt) {
        this.selectedInterface = virt;
        this.selectedInterfaceRange = [virt];
        return '';
      }
      const portName = this.resolveInterfaceName(args[0]);
      if (!portName || !this.d().getPort(portName)) {
        return `% Invalid interface name "${args[0]}"`;
      }
      this.selectedInterface = portName;
      this.selectedInterfaceRange = [portName];
      return '';
    });

    this.configIfTrie.register('switchport mode access', 'Set interface to access mode', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'access') ? '' : '% Error'
      );
    });

    this.configIfTrie.register('switchport mode trunk', 'Set interface to trunk mode', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'trunk') ? '' : '% Error'
      );
    });

    this.configIfTrie.register('switchport mode dynamic auto', 'Negotiate trunk via DTP (passive)', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.d().getDtpAgent().setAdminMode(portName, 'dynamic-auto');
        return '';
      });
    });

    this.configIfTrie.register('switchport mode dynamic desirable', 'Negotiate trunk via DTP (active)', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.d().getDtpAgent().setAdminMode(portName, 'dynamic-desirable');
        return '';
      });
    });

    this.configIfTrie.register('switchport nonegotiate', 'Force trunk without DTP', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.d().getDtpAgent().setAdminMode(portName, 'nonegotiate');
        return '';
      });
    });

    this.configIfTrie.register('no switchport nonegotiate', 'Re-enable DTP negotiation', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.d().getDtpAgent().setAdminMode(portName, 'dynamic-auto');
        return '';
      });
    });

    this.configIfTrie.registerGreedy('switchport access vlan', 'Assign interface to access VLAN', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId) || vlanId < 1 || vlanId > 4094) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportAccessVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    this.configIfTrie.registerGreedy('switchport trunk native vlan', 'Set trunk native VLAN', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.d().setTrunkNativeVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    this.configIfTrie.registerGreedy('switchport trunk allowed vlan', 'Set trunk allowed VLANs', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const sub = args[0].toLowerCase();

      if (sub === 'all') {
        return this.applyToSelectedInterfaces(portName =>
          this.d().setTrunkAllowedVlansAll(portName) ? '' : '% Error'
        );
      }
      if (sub === 'none') {
        return this.applyToSelectedInterfaces(portName =>
          this.d().setTrunkAllowedVlansNone(portName) ? '' : '% Error'
        );
      }
      if (sub === 'add') {
        if (args.length < 2) return '% Incomplete command.';
        const vlans = this.parseVlanList(args[1]);
        if (!vlans) return '% Invalid VLAN list';
        return this.applyToSelectedInterfaces(portName =>
          this.d().addTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
        );
      }
      if (sub === 'remove') {
        if (args.length < 2) return '% Incomplete command.';
        const vlans = this.parseVlanList(args[1]);
        if (!vlans) return '% Invalid VLAN list';
        return this.applyToSelectedInterfaces(portName =>
          this.d().removeTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
        );
      }
      if (sub === 'except') {
        if (args.length < 2) return '% Incomplete command.';
        const vlans = this.parseVlanList(args[1]);
        if (!vlans) return '% Invalid VLAN list';
        return this.applyToSelectedInterfaces(portName =>
          this.d().setTrunkAllowedVlansExcept(portName, vlans) ? '' : '% Error'
        );
      }

      // Default: replace the full list
      const vlans = this.parseVlanList(args[0]);
      if (!vlans) return '% Invalid VLAN list';
      return this.applyToSelectedInterfaces(portName =>
        this.d().setTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
      );
    });

    // ── switchport extras / EtherChannel (recorded for show run) ──
    const recordIf = (line: string) => {
      const ifs = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const l = this.ifExtra.get(i) ?? [];
        l.push(line);
        this.ifExtra.set(i, l);
      }
      return '';
    };
    for (const sub of [
      'switchport trunk encapsulation',
      'switchport voice', 'switchport priority',
      'channel-protocol', 'storm-control', 'mls qos',
      'speed', 'duplex', 'mdix', 'power', 'srr-queue', 'load-interval',
    ]) {
      this.configIfTrie.registerGreedy(sub, `Interface ${sub}`, (args) =>
        recordIf(`${sub} ${args.join(' ')}`.trim()));
    }

    const removeIf = (prefix: string) => {
      const ifs = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const l = this.ifExtra.get(i);
        if (l) this.ifExtra.set(i, l.filter(x => !x.startsWith(prefix)));
      }
      return '';
    };
    this.configIfTrie.register('no switchport voice vlan', 'Remove voice VLAN', () =>
      removeIf('switchport voice'));

    this.configIfTrie.registerGreedy('switchport trunk pruning vlan', 'Set pruning-eligible VLANs', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const sub = args[0].toLowerCase();
      if (sub === 'none') return recordIf('switchport trunk pruning vlan none');
      if (sub === 'add' || sub === 'remove' || sub === 'except') {
        if (args.length < 2) return '% Incomplete command.';
        if (!this.parseVlanList(args[1])) return '% Invalid VLAN list';
        return recordIf(`switchport trunk pruning vlan ${sub} ${args[1]}`);
      }
      if (!this.parseVlanList(args[0])) return '% Invalid VLAN list';
      return recordIf(`switchport trunk pruning vlan ${args[0]}`);
    });
    this.configIfTrie.register('no switchport trunk pruning vlan', 'Reset pruning-eligible VLANs', () =>
      removeIf('switchport trunk pruning'));

    this.configIfTrie.registerGreedy('channel-group', 'EtherChannel membership', (args) => {
      if (args.length < 3) return '% Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 1 || id > 64) return '% Invalid channel-group id';
      if (args[1].toLowerCase() !== 'mode') return '% Incomplete command.';
      const m = args[2].toLowerCase();
      let mode: 'active' | 'passive' | 'on';
      if (m === 'active' || m === 'desirable') mode = 'active';
      else if (m === 'passive' || m === 'auto') mode = 'passive';
      else if (m === 'on') mode = 'on';
      else return '% Invalid channel-group mode';
      return this.applyToSelectedInterfaces(portName => {
        this.d().getLacpAgent().addPortToGroup(portName, id, mode);
        return '';
      });
    });
    this.configIfTrie.registerGreedy('no channel-group', 'Remove EtherChannel membership', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.d().getLacpAgent().removePort(portName);
        return '';
      });
    });

    this.configIfTrie.register('shutdown', 'Disable interface', () => {
      return this.applyToSelectedInterfaces(portName => {
        const port = this.d().getPort(portName);
        if (port) { port.setUp(false); return ''; }
        return '% Error';
      });
    });

    this.configIfTrie.register('no shutdown', 'Enable interface', () => {
      return this.applyToSelectedInterfaces(portName => {
        const port = this.d().getPort(portName);
        if (port) { port.setUp(true); return ''; }
        return '% Error';
      });
    });

    this.configIfTrie.registerGreedy('description', 'Interface description', (args) => {
      if (!this.selectedInterface || args.length < 1) return '% Incomplete command.';
      return this.applyToSelectedInterfaces(portName => {
        this.d().setInterfaceDescription(portName, args.join(' '));
        return '';
      });
    });

    this.configIfTrie.register('no description', 'Remove interface description', () => {
      if (!this.selectedInterface) return '';
      return this.applyToSelectedInterfaces(portName => {
        this.d().setInterfaceDescription(portName, '');
        return '';
      });
    });

    this.configIfTrie.register('ip dhcp snooping trust', 'Set interface as trusted for DHCP snooping', () => {
      const cfg = this.d()._getDHCPSnoopingConfig();
      return this.applyToSelectedInterfaces(portName => {
        cfg.trustedPorts.add(portName);
        return '';
      });
    });

    this.configIfTrie.registerGreedy('ip dhcp snooping limit rate', 'Set DHCP snooping rate limit', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const rate = parseInt(args[0], 10);
      if (isNaN(rate) || rate < 1) return '% Invalid rate value';
      const cfg = this.d()._getDHCPSnoopingConfig();
      return this.applyToSelectedInterfaces(portName => {
        cfg.rateLimits.set(portName, rate);
        return '';
      });
    });
  }

  // ─── Running Config Builder ───────────────────────────────────────

  buildRunningConfig(sw: Switch): string {
    const lines = [
      'Building configuration...',
      '',
      'Current configuration:',
      '!',
      `hostname ${sw.getHostname()}`,
      '!',
    ];

    const enableSecret = sw.getEnableSecret();
    if (enableSecret) lines.push(`enable secret ${renderSecretField(enableSecret.value, enableSecret.algo)}`);
    const enablePassword = sw.getEnablePassword();
    if (enablePassword) lines.push(`enable password ${renderPasswordField(enablePassword.value, enablePassword.algo, false)}`);
    if (enableSecret || enablePassword) lines.push('!');

    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      lines.push('!');
    }

    // ── ARP ACLs ──
    for (const [, acl] of sw._getArpAccessLists()) {
      lines.push(`arp access-list ${acl.name}`);
      for (const e of acl.entries) lines.push(` ${e.raw}`);
      lines.push('!');
    }

    // ── DAI globals ──
    const dai = sw._getArpInspectionConfig();
    if (dai.vlans.size > 0) {
      const sorted = Array.from(dai.vlans).sort((a, b) => a - b);
      lines.push(`ip arp inspection vlan ${this.compactVlanList(sorted)}`);
    }
    if (dai.validate.srcMac || dai.validate.dstMac || dai.validate.ip) {
      const toks: string[] = [];
      if (dai.validate.srcMac) toks.push('src-mac');
      if (dai.validate.dstMac) toks.push('dst-mac');
      if (dai.validate.ip) toks.push('ip');
      lines.push(`ip arp inspection validate ${toks.join(' ')}`);
    }
    for (const [vlan, f] of dai.vlanAclFilters) {
      lines.push(`ip arp inspection filter ${f.aclName} vlan ${vlan}${f.staticMode ? ' static' : ''}`);
    }
    if (dai.errDisableRecoverySec > 0) {
      lines.push('errdisable recovery cause arp-inspection');
      lines.push(`errdisable recovery interval ${dai.errDisableRecoverySec}`);
    }
    if (sw._getPsecRecoverySec() > 0) {
      lines.push('errdisable recovery cause psecure-violation');
    }

    const cdpAgent = (sw as unknown as { getCdpAgent?: () => import('../../cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
    if (cdpAgent) for (const l of cdpAgent.runningConfigGlobalLines()) lines.push(l);
    const lldpAgent = (sw as unknown as { getLldpAgent?: () => import('../../lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
    if (lldpAgent) for (const l of lldpAgent.runningConfigGlobalLines()) lines.push(l);
    const stpAgent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
    if (stpAgent) for (const l of stpAgent.runningConfigGlobalLines()) lines.push(l);
    const vtpAgent = (sw as unknown as { getVtpAgent?: () => import('../../vtp/VtpAgent').VtpAgent }).getVtpAgent?.();
    if (vtpAgent) for (const l of vtpAgent.runningConfigGlobalLines()) lines.push(l);
    if (dai.vlans.size > 0 || dai.vlanAclFilters.size > 0) lines.push('!');

    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    const descs = sw._getInterfaceDescriptions();
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      const desc = descs.get(portName);
      if (desc) lines.push(` description ${desc}`);
      const dtpAdmin = sw.getDtpAgent().getAdminMode(portName);
      if (dtpAdmin === 'dynamic-auto') {
        lines.push(' switchport mode dynamic auto');
      } else if (dtpAdmin === 'dynamic-desirable') {
        lines.push(' switchport mode dynamic desirable');
      } else if (dtpAdmin === 'nonegotiate') {
        lines.push(' switchport nonegotiate');
      } else if (dtpAdmin === 'trunk') {
        lines.push(' switchport mode trunk');
      } else {
        lines.push(' switchport mode access');
      }
      if (cfg.mode === 'trunk') {
        if (cfg.trunkNativeVlan !== 1) {
          lines.push(` switchport trunk native vlan ${cfg.trunkNativeVlan}`);
        }
        if (cfg.trunkAllowedVlans.size < 4094) {
          if (cfg.trunkAllowedVlans.size === 0) {
            lines.push(` switchport trunk allowed vlan none`);
          } else {
            const sorted = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
            lines.push(` switchport trunk allowed vlan ${this.compactVlanList(sorted)}`);
          }
        }
      } else if (cfg.accessVlan !== 1) {
        lines.push(` switchport access vlan ${cfg.accessVlan}`);
      }
      for (const l of this.ifExtra.get(portName) ?? []) lines.push(` ${l}`);
      for (const l of this.ifStp.get(portName) ?? []) lines.push(` ${l}`);
      if (dai.trustedPorts.has(portName)) {
        lines.push(' ip arp inspection trust');
      }
      const daiRate = dai.rateLimits.get(portName);
      if (daiRate && daiRate > 0) {
        lines.push(` ip arp inspection limit rate ${daiRate}`);
      }
      for (const l of this.renderPortSecurityLines(port)) lines.push(` ${l}`);
      if (cdpAgent) for (const l of cdpAgent.runningConfigInterfaceLines(portName)) lines.push(` ${l}`);
      if (lldpAgent) for (const l of lldpAgent.runningConfigInterfaceLines(portName)) lines.push(` ${l}`);
      for (const l of sw.getLacpAgent().runningConfigInterfaceLines(portName)) lines.push(` ${l}`);
      if (!port.getIsUp()) {
        lines.push(` shutdown`);
      }
      lines.push('!');
    }

    for (const l of this.logging.asRunningConfigLines()) lines.push(l);

    lines.push('end');
    return lines.join('\n');
  }

  // ─── Show Command Implementations ────────────────────────────────

  private showMACAddressTable(sw: Switch): string {
    const entries = sw.getMACTable();
    if (entries.length === 0) return 'Mac Address Table\n-------------------------------------------\nNo entries.';

    const lines = [
      'Mac Address Table',
      '-------------------------------------------',
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
    ];

    const sorted = [...entries].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    for (const e of sorted) {
      const vlan = String(e.vlan).padEnd(8);
      const mac = e.mac.padEnd(18);
      const type = e.type === 'static' ? 'STATIC  ' : 'DYNAMIC ';
      lines.push(`${vlan}${mac}${type}    ${e.port}`);
    }

    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${entries.length}`);
    return lines.join('\n');
  }

  private showVlanBrief(sw: Switch, filter?: { id?: number; name?: string }): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    let shown = 0;
    for (const [id, vlan] of vlans) {
      if (filter?.id !== undefined && id !== filter.id) continue;
      if (filter?.name !== undefined && vlan.name.toLowerCase() !== filter.name.toLowerCase()) continue;
      shown++;
      const name = vlan.name.padEnd(33);
      const status = 'active';

      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(this.abbreviateInterface(portName));
        }
      }

      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(5)}${name}${status.padEnd(10)}${portsStr}`);
    }

    if (filter && shown === 0) {
      return filter.id !== undefined
        ? `VLAN id ${filter.id} not found in current VLAN database`
        : `ERROR: VLAN ${filter.name} not found in current VLAN database`;
    }
    return lines.join('\n');
  }

  private showAllInterfacesDetail(): string {
    const sw = this.d();
    return sw.getPortNames().map((n) => showInterface(sw, n)).join('\n');
  }

  private showSwitchportDetail(name: string): string {
    const c = this.d().getSwitchportConfig(name);
    const mode = c?.mode === 'trunk' ? 'trunk' : 'static access';
    const oper = c?.mode ?? 'access';
    const lines = [
      `Name: ${this.abbreviateInterface(name)}`,
      `Switchport: Enabled`,
      `Administrative Mode: ${mode}`,
      `Operational Mode: ${oper}`,
      `Administrative Trunking Encapsulation: dot1q`,
      `Negotiation of Trunking: ${c?.mode === 'trunk' ? 'On' : 'Off'}`,
      `Access Mode VLAN: ${c?.accessVlan ?? 1} (${this.d().getVLANs().get(c?.accessVlan ?? 1)?.name ?? 'default'})`,
      `Trunking Native Mode VLAN: ${c?.trunkNativeVlan ?? 1} (default)`,
    ];
    if (c?.mode === 'trunk') {
      const allowed = c.trunkAllowedVlans.size >= 4094
        ? 'ALL' : this.compactVlanList(Array.from(c.trunkAllowedVlans).sort((a, b) => a - b));
      lines.push(`Trunking VLANs Enabled: ${allowed}`);
    }
    if (c?.voiceVlan) lines.push(`Voice VLAN: ${c.voiceVlan}`);
    return lines.join('\n');
  }

  private showInterfacesCounters(name: string | null): string {
    const sw = this.d();
    const rows = ['Port            InOctets   InUcastPkts   OutOctets  OutUcastPkts'];
    for (const [pn, port] of sw._getPortsInternal()) {
      if (name && pn !== name) continue;
      const c = port.getCounters();
      rows.push(
        `${this.abbreviateInterface(pn).padEnd(15)} ${String(c.bytesIn).padStart(9)} ` +
        `${String(c.framesIn).padStart(13)} ${String(c.bytesOut).padStart(11)} ${String(c.framesOut).padStart(13)}`,
      );
    }
    if (name && rows.length === 1) return `% Invalid input detected at '^' marker.`;
    return rows.join('\n');
  }

  private showInterfacesDescriptionTable(): string {
    const sw = this.d();
    const rows = ['Interface                      Status         Protocol Description'];
    for (const [name, port] of sw._getPortsInternal()) {
      const up = port.getIsUp();
      const status = up ? 'up' : 'admin down';
      const proto = up && port.isConnected() ? 'up' : 'down';
      const desc = sw.getInterfaceDescription(name) || '';
      rows.push(`${this.abbreviateInterface(name).padEnd(31)}${status.padEnd(15)}${proto.padEnd(9)}${desc}`);
    }
    return rows.join('\n');
  }

  private showInterfacesStatus(sw: Switch): string {
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'Port        Name               Status       Vlan       Duplex  Speed Type',
      '----------  -----------------  -----------  ---------  ------  ----- ----',
    ];

    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      const shortName = this.abbreviateInterface(portName).padEnd(12);
      const desc = (sw.getInterfaceDescription(portName) || '').slice(0, 17).padEnd(19);
      const status = (port.getIsUp() ? (port.isConnected() ? 'connected' : 'notconnect') : 'disabled').padEnd(13);
      const vlanStr = cfg?.mode === 'trunk' ? 'trunk' : String(cfg?.accessVlan || 1);
      const duplex = 'a-full';
      const speed = portName.startsWith('Gi') ? 'a-1000' : 'a-100';
      const type = portName.startsWith('Gi') ? '1000BASE-T' : '10/100BaseTX';

      lines.push(`${shortName}${desc}${status}${vlanStr.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}`);
    }

    return lines.join('\n');
  }

  private showSpanningTree(sw: Switch, vlanId = 1): string {
    const stpStates = sw._getSTPStates();
    const agent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
    const root = agent?.getRootBridge();
    const cost = agent?.getRootPathCost() ?? 0;
    const rootPort = agent?.getRootPort();
    const rootMacFmt = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const rootPrio = root ? root.priority + 1 : 32769;
    const lines = [
      `VLAN${String(vlanId).padStart(4, '0')}`,
      '  Spanning tree enabled protocol ieee',
      `  Root ID    Priority    ${rootPrio}`,
      `             Address     ${rootMacFmt}`,
      `             Cost        ${cost}`,
      rootPort
        ? `             Port        ${this.abbreviateInterface(rootPort)}`
        : '             This bridge is the root',
      '',
      'Interface        Role  Sts  Cost      Prio.Nbr  Type',
      '---------------- ----  ---  --------  --------  ----',
    ];
    for (const [portName, state] of stpStates) {
      const shortName = this.abbreviateInterface(portName).padEnd(17);
      const stpRole = agent?.getPortRole(portName) ?? 'designated';
      const role =
        stpRole === 'root' ? 'Root'
        : stpRole === 'alternate' ? 'Altn'
        : stpRole === 'backup' ? 'Back'
        : stpRole === 'disabled' ? 'Disa'
        : 'Desg';
      const sts = state === 'forwarding' ? 'FWD'
        : state === 'blocking' ? 'BLK'
        : state === 'listening' ? 'LIS'
        : state === 'learning' ? 'LRN'
        : 'DIS';
      const portCost = agent?.getPortCost(portName) ?? 19;
      const linkType = agent?.getPortLinkType(portName) === 'shared' ? 'Shr' : 'P2p';
      const edge = agent?.isPortFastOperational(portName) ? ' Edge' : '';
      lines.push(`${shortName}${role.padEnd(6)}${sts.padEnd(5)}${String(portCost).padEnd(10)}128.${portName.replace(/\D/g, '').padEnd(6)}${linkType}${edge}`);
    }
    return lines.join('\n');
  }

  private stpAgentOf(sw: Switch) {
    return (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
  }

  private stpSummaryCounts(sw: Switch): string {
    let blk = 0, lis = 0, lrn = 0, fwd = 0;
    for (const [, state] of sw._getSTPStates()) {
      if (state === 'blocking') blk++;
      else if (state === 'listening') lis++;
      else if (state === 'learning') lrn++;
      else if (state === 'forwarding') fwd++;
    }
    const active = blk + lis + lrn + fwd;
    return `${String(blk).padEnd(9)}${String(lis).padEnd(10)}${String(lrn).padEnd(9)}${String(fwd).padEnd(11)}${active}`;
  }

  private showStpRoot(sw: Switch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const root = agent?.getRootBridge();
    const cost = agent?.getRootPathCost() ?? 0;
    const rootPort = agent?.getRootPort();
    const mac = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const prio = root ? root.priority + vlanId : 32768 + vlanId;
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      '                                        Root    Hello Max Fwd',
      'Vlan             Root ID              Cost    Port    Time  Age Dly',
      '---------------- -------------------- ------- ------- ----- --- ---',
      `${vlan.padEnd(17)}${prio} ${mac}  ${String(cost).padEnd(8)}${(rootPort ? this.abbreviateInterface(rootPort) : '').padEnd(8)}2     20  15`,
    ].join('\n');
  }

  private showStpBridge(sw: Switch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const own = agent?.ownBridgeId();
    const mac = own ? this.formatMacCisco(new MACAddress(own.mac)) : '0000.0000.0000';
    const prio = (own ? own.priority : 32768) + vlanId;
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      '                                                   Hello  Max  Fwd',
      'Vlan             Bridge ID                          Time  Age  Dly  Protocol',
      '---------------- ---------------------------------- -----  ---  ---  --------',
      `${vlan.padEnd(17)}${prio} (${prio - vlanId}, ${vlanId})  ${mac}  2     20   15   ieee`,
    ].join('\n');
  }

  private showStpBlockedPorts(sw: Switch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const blocked: string[] = [];
    for (const [portName, state] of sw._getSTPStates()) {
      const role = agent?.getPortRole(portName);
      if (state === 'blocking' || role === 'alternate' || role === 'backup') {
        blocked.push(this.abbreviateInterface(portName));
      }
    }
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      'Name                 Blocked Interfaces List',
      '-------------------- ------------------------------------',
      `${vlan.padEnd(21)}${blocked.join(', ')}`,
      '',
      `Number of blocked ports (segments) in the system : ${blocked.length}`,
    ].join('\n');
  }

  private showStpDetail(sw: Switch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const isRoot = agent?.isRoot() ?? true;
    const root = agent?.getRootBridge();
    const own = agent?.ownBridgeId();
    const cost = agent?.getRootPathCost() ?? 0;
    const rootMac = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const ownMac = own ? this.formatMacCisco(new MACAddress(own.mac)) : '0000.0000.0000';
    const out: string[] = [
      ` VLAN${String(vlanId).padStart(4, '0')} is executing the ${this.stpMode} compatible Spanning Tree protocol`,
      `  Bridge Identifier has priority ${own ? own.priority : 32768}, sysid ${vlanId}, address ${ownMac}`,
      isRoot
        ? '  We are the root of the spanning tree'
        : `  Current root has priority ${root ? root.priority : 32768}, address ${rootMac}`,
      `  Root port is ${agent?.getRootPort() ? this.abbreviateInterface(agent.getRootPort()!) : 'N/A'}, cost of root path is ${cost}`,
      '  Hello Time 2 sec  Max Age 20 sec  Forward Delay 15 sec',
      '',
    ];
    for (const [portName, state] of sw._getSTPStates()) {
      const role = agent?.getPortRole(portName) ?? 'designated';
      out.push(
        ` Port ${portName} of VLAN${String(vlanId).padStart(4, '0')} is ${role} ${state}`,
        `   Port path cost 19, Port priority 128`,
      );
    }
    return out.join('\n');
  }

  // ─── DHCP Snooping Display ───────────────────────────────────────

  private showDHCPSnooping(sw: Switch): string {
    const cfg = sw._getDHCPSnoopingConfig();
    const lines: string[] = [];

    lines.push(`Switch DHCP snooping is ${cfg.enabled ? 'enabled' : 'disabled'}`);

    if (cfg.vlans.size > 0) {
      const vlanList = Array.from(cfg.vlans).sort((a, b) => a - b).join(',');
      lines.push(`DHCP snooping is configured on following VLANs:`);
      lines.push(`${vlanList}`);
    }

    if (cfg.verifyMac) {
      lines.push(`DHCP snooping verify mac-address is enabled`);
    }

    if (cfg.trustedPorts.size > 0) {
      const trusted = Array.from(cfg.trustedPorts)
        .map(p => this.abbreviateInterface(p))
        .join(', ');
      lines.push(`Trusted ports: ${trusted}`);
    }

    for (const [port, rate] of cfg.rateLimits) {
      lines.push(`  ${this.abbreviateInterface(port)}: rate limit ${rate} pps`);
    }

    return lines.join('\n');
  }

  private showDHCPSnoopingBinding(sw: Switch): string {
    const bindings = sw._getSnoopingBindings();
    const lines: string[] = [];

    lines.push('MacAddress          IP address        Lease(sec)  Type           VLAN  Interface');
    lines.push('------------------  ----------------  ----------  -------------  ----  --------------------');

    if (bindings.length === 0) {
      lines.push('Total number of bindings: 0');
    } else {
      for (const b of bindings) {
        const mac = b.macAddress.padEnd(20);
        const ip = b.ipAddress.padEnd(18);
        const lease = String(b.lease).padEnd(12);
        const type = b.type.padEnd(15);
        const vlan = String(b.vlan).padEnd(6);
        lines.push(`${mac}${ip}${lease}${type}${vlan}${b.port}`);
      }
      lines.push(`Total number of bindings: ${bindings.length}`);
    }

    return lines.join('\n');
  }

  private showLogging(sw: Switch): string {
    const logs = sw._getSnoopingLog();
    const lines: string[] = [];

    lines.push(`Syslog logging: ${this.logging.enabled ? 'enabled' : 'disabled'}`);
    for (const h of this.logging.hosts) {
      lines.push(`  Logging to ${h}`);
    }
    lines.push('');

    if (logs.length > 0) {
      for (const log of logs) {
        lines.push(log);
      }
    } else {
      const cfg = sw._getDHCPSnoopingConfig();
      if (cfg.enabled) {
        lines.push(`*${new Date().toLocaleString()}: %DHCP_SNOOPING-5-DHCP_SNOOPING_ENABLED: DHCP Snooping enabled globally`);
        if (cfg.verifyMac) {
          lines.push(`*${new Date().toLocaleString()}: %DHCP_SNOOPING-5-DHCP_SNOOPING_VERIFY_MAC: DHCP snooping verify mac-address enabled`);
        }
      }
    }

    return lines.join('\n');
  }

  // ─── DAI Display ──────────────────────────────────────────────────

  private showArpInspection(sw: Switch): string {
    const cfg = sw._getArpInspectionConfig();
    const lines: string[] = [];
    const vlans = Array.from(cfg.vlans).sort((a, b) => a - b);
    lines.push('Source Mac Validation      : ' + (cfg.validate.srcMac ? 'Enabled' : 'Disabled'));
    lines.push('Destination Mac Validation : ' + (cfg.validate.dstMac ? 'Enabled' : 'Disabled'));
    lines.push('IP Address Validation      : ' + (cfg.validate.ip ? 'Enabled' : 'Disabled'));
    lines.push('');
    lines.push(' Vlan     Configuration    Operation   ACL Match          Static ACL');
    lines.push(' ----     -------------    ---------   ---------          ----------');
    if (vlans.length === 0) {
      lines.push(' (no VLANs enabled for ARP inspection)');
    } else for (const v of vlans) {
      const filt = cfg.vlanAclFilters.get(v);
      const acl = filt ? filt.aclName : '';
      const stat = filt && filt.staticMode ? 'Yes' : 'No';
      lines.push(` ${String(v).padEnd(8)} Enabled          Active      ${acl.padEnd(18)} ${stat}`);
    }
    return lines.join('\n');
  }

  private showArpInspectionVlan(sw: Switch, spec: string): string {
    const wanted = new Set<number>();
    for (const part of spec.split(',')) {
      const m = part.match(/^(\d+)-(\d+)$/);
      if (m) for (let i = +m[1]; i <= +m[2]; i++) wanted.add(i);
      else { const n = parseInt(part, 10); if (!isNaN(n)) wanted.add(n); }
    }
    const cfg = sw._getArpInspectionConfig();
    const lines: string[] = [' Vlan     Configuration    Operation   ACL Match          Static ACL',
                            ' ----     -------------    ---------   ---------          ----------'];
    for (const v of [...wanted].sort((a, b) => a - b)) {
      const enabled = cfg.vlans.has(v);
      const filt = cfg.vlanAclFilters.get(v);
      const acl = filt ? filt.aclName : '';
      const stat = filt && filt.staticMode ? 'Yes' : 'No';
      lines.push(` ${String(v).padEnd(8)} ${(enabled ? 'Enabled' : 'Disabled').padEnd(16)} ` +
                 `${(enabled ? 'Active' : 'Inactive').padEnd(11)} ${acl.padEnd(18)} ${stat}`);
    }
    return lines.join('\n');
  }

  private showArpInspectionStats(sw: Switch): string {
    const stats = sw._getArpInspectionStats();
    const lines = [
      ' Vlan  Forwarded     Dropped       DHCP-Drops    ACL-Drops',
      ' ----  ---------     -------       ----------    ---------',
    ];
    const ports = sw._getPortsInternal();
    let fwd = 0, drop = 0, bind = 0, acl = 0;
    for (const [port] of ports) {
      const s = stats.get(port);
      if (!s) continue;
      fwd += s.forwarded; drop += s.dropped;
      bind += s.droppedBindingMismatch; acl += s.droppedAclDeny;
    }
    lines.push(` ${'(all)'.padEnd(5)} ${String(fwd).padEnd(13)} ${String(drop).padEnd(13)} ` +
               `${String(bind).padEnd(13)} ${acl}`);
    lines.push('');
    lines.push(' Interface          Packets Received  Permitted  Dropped');
    lines.push(' ----------------   ----------------  ---------  -------');
    for (const [port] of ports) {
      const s = stats.get(port);
      if (!s || s.received === 0) continue;
      lines.push(` ${this.abbreviateInterface(port).padEnd(18)} ` +
                 `${String(s.received).padEnd(17)} ${String(s.forwarded).padEnd(10)} ${s.dropped}`);
    }
    return lines.join('\n');
  }

  private showArpInspectionIfs(sw: Switch): string {
    const cfg = sw._getArpInspectionConfig();
    const errd = sw._getArpErrDisabledPorts();
    const lines = [
      ' Interface          Trust State     Rate (pps)    Burst Interval     ErrDisable',
      ' ----------------   -------------   ----------    --------------     ----------',
    ];
    for (const port of sw.getPortNames()) {
      const trust = cfg.trustedPorts.has(port) ? 'Trusted' : 'Untrusted';
      const rate = cfg.rateLimits.get(port);
      const rateStr = rate && rate > 0 ? String(rate) : 'None';
      const burst = String(cfg.rateBurstSec);
      const err = errd.has(port) ? 'Yes' : 'No';
      lines.push(` ${this.abbreviateInterface(port).padEnd(18)} ${trust.padEnd(15)} ` +
                 `${rateStr.padEnd(13)} ${burst.padEnd(18)} ${err}`);
    }
    return lines.join('\n');
  }

  private showArpAcls(sw: Switch): string {
    const map = sw._getArpAccessLists();
    if (map.size === 0) return '';
    const lines: string[] = [];
    for (const [name, acl] of map) {
      lines.push(`ARP access list ${name}`);
      for (const e of acl.entries) lines.push(`    ${e.raw}`);
    }
    return lines.join('\n');
  }

  private showErrdisableRecovery(): string {
    const dai = this.d()._getArpInspectionConfig();
    const arpRec = dai.errDisableRecoverySec > 0;
    const psecRec = this.d()._getPsecRecoverySec() > 0;
    const interval = arpRec ? dai.errDisableRecoverySec
      : psecRec ? this.d()._getPsecRecoverySec() : 300;
    const causes: [string, boolean][] = [
      ['arp-inspection', arpRec],
      ['psecure-violation', psecRec],
      ['bpduguard', false],
      ['loopback', false],
      ['link-flap', false],
    ];
    const lines = [
      'ErrDisable Reason            Timer Status',
      '-----------------            --------------',
    ];
    for (const [cause, on] of causes) {
      lines.push(`${cause.padEnd(29)}${on ? 'Enabled' : 'Disabled'}`);
    }
    lines.push('');
    lines.push(`Timer interval: ${interval} seconds`);
    return lines.join('\n');
  }

  // ─── Interface Resolution ─────────────────────────────────────────

  /**
   * Virtual (non-physical) L2 interfaces this switch accepts:
   * Port-channel only. `Vlan<n>` is an L3 SVI and stays rejected on an
   * L2-only switch (returns null → "% Invalid interface name").
   */
  private virtualInterfaceName(input: string): string | null {
    const m = input.replace(/\s+/g, '').match(/^(?:po|port-?channel)(\d+)$/i);
    return m ? `Port-channel${m[1]}` : null;
  }

  private resolveInterfaceName(input: string): string | null {
    const lower = input.toLowerCase();

    for (const name of this.d().getPortNames()) {
      if (name.toLowerCase() === lower) return name;
    }

    const prefixMap: Record<string, string> = {
      'fa': 'FastEthernet',
      'fas': 'FastEthernet',
      'fast': 'FastEthernet',
      'faste': 'FastEthernet',
      'fastet': 'FastEthernet',
      'fasteth': 'FastEthernet',
      'fastetherr': 'FastEthernet',
      'fastethernet': 'FastEthernet',
      'gi': 'GigabitEthernet',
      'gig': 'GigabitEthernet',
      'giga': 'GigabitEthernet',
      'gigab': 'GigabitEthernet',
      'gigabi': 'GigabitEthernet',
      'gigabit': 'GigabitEthernet',
      'gigabite': 'GigabitEthernet',
      'gigabitet': 'GigabitEthernet',
      'gigabiteth': 'GigabitEthernet',
      'gigabitethernet': 'GigabitEthernet',
      'eth': 'eth',
    };

    const match = lower.match(/^([a-z]+)([\d/.-]+)$/);
    if (!match) return null;

    const [, prefix, numbers] = match;
    const fullPrefix = prefixMap[prefix];
    if (!fullPrefix) return null;

    const resolved = `${fullPrefix}${numbers}`;

    for (const name of this.d().getPortNames()) {
      if (name === resolved) return name;
    }

    return null;
  }

  private handleInterfaceRange(args: string[]): string {
    if (args.length < 1) return '% Incomplete command.';

    const rangeStr = args.join(' ').replace(/\s*-\s*/g, '-');
    const rangeMatch = rangeStr.match(/^([a-zA-Z]+)\s*([\d/]+)-([\d/]+)$/);

    if (!rangeMatch) {
      const simpleMatch = rangeStr.match(/^([a-zA-Z]+)([\d]+\/[\d]+)-([\d]+)$/);
      if (!simpleMatch) return '% Invalid interface range.';

      const [, prefix, start, endNum] = simpleMatch;
      const slashIdx = start.lastIndexOf('/');
      const baseNum = start.substring(0, slashIdx + 1);
      const startNum = parseInt(start.substring(slashIdx + 1), 10);
      const end = parseInt(endNum, 10);

      const interfaces: string[] = [];
      for (let i = startNum; i <= end; i++) {
        const name = this.resolveInterfaceName(`${prefix}${baseNum}${i}`);
        if (name) interfaces.push(name);
      }

      if (interfaces.length === 0) return '% No valid interfaces in range.';
      this.selectedInterface = interfaces[0];
      this.selectedInterfaceRange = interfaces;
      this.mode = 'config-if';
      return '';
    }

    const [, prefix, startSlot, endSlot] = rangeMatch;
    const slashIdx = startSlot.lastIndexOf('/');
    const baseSlot = startSlot.substring(0, slashIdx + 1);
    const startNum = parseInt(startSlot.substring(slashIdx + 1), 10);
    const endNum = parseInt(endSlot, 10);

    const interfaces: string[] = [];
    for (let i = startNum; i <= endNum; i++) {
      const name = this.resolveInterfaceName(`${prefix}${baseSlot}${i}`);
      if (name) interfaces.push(name);
    }

    if (interfaces.length === 0) return '% No valid interfaces in range.';
    this.selectedInterface = interfaces[0];
    this.selectedInterfaceRange = interfaces;
    this.mode = 'config-if';
    return '';
  }

  private applyToSelectedInterfaces(fn: (portName: string) => string): string {
    const results: string[] = [];
    for (const portName of this.selectedInterfaceRange) {
      const result = fn(portName);
      if (result) results.push(result);
    }
    return results.join('\n');
  }

  // ─── Utility ──────────────────────────────────────────────────────

  /** Compact a sorted VLAN list into ranges, e.g. [1,2,3,5] → "1-3,5" */
  private compactVlanList(sorted: number[]): string {
    if (sorted.length === 0) return '';
    const ranges: string[] = [];
    let start = sorted[0], end = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        ranges.push(start === end ? String(start) : `${start}-${end}`);
        start = end = sorted[i];
      }
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    return ranges.join(',');
  }

  private parseVlanList(input: string): Set<number> | null {
    const vlans = new Set<number>();
    const parts = input.split(',');
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (isNaN(start) || isNaN(end)) return null;
        for (let i = start; i <= end; i++) vlans.add(i);
      } else {
        const num = parseInt(part, 10);
        if (isNaN(num)) return null;
        vlans.add(num);
      }
    }
    return vlans;
  }

  private abbreviateInterface(name: string): string {
    return name
      .replace('FastEthernet', 'Fa')
      .replace('GigabitEthernet', 'Gi');
  }
}
