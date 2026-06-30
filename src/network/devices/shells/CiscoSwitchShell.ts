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
import { MACAddress, IPAddress, SubnetMask } from '../../core/types';
import { renderSecretField, renderPasswordField } from './cisco/ciscoPasswordRender';
import { parsePingArgs, formatCiscoPing } from './cisco/ciscoPing';
import { showInterface } from './cisco/CiscoShowCommands';
import { showSwitchVersion } from './cisco/CiscoCommonShow';
import { buildConfigDhcpCommands } from './cisco/CiscoDhcpCommands';
import type { CiscoShellContext } from './cisco/CiscoConfigCommands';
import type { Router } from '../Router';

/** CLI Mode (FSM State) */
export type CLIMode =
  | 'user' | 'privileged' | 'config' | 'config-if' | 'config-vlan'
  | 'config-mst' | 'config-line' | 'config-acl' | 'config-dhcp';

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
  private configDhcpTrie = new CommandTrie();
  private selectedDhcpPool: string | null = null;

  // STP state (switch-only, L2)
  private stpMode = 'pvst';
  private ifStp = new Map<string, string[]>();
  private ifExtra = new Map<string, string[]>();
  private configAclTrie = new CommandTrie();
  private selectedAcl: string | null = null;
  private selectedArpAcl: string | null = null;
  private acls = new Map<string, string[]>();

  constructor() {
    super();
    this.initializeCommands();
  }

  // ─── ISwitchShell ────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    const dbg = (sw as unknown as { getDebugService?: () => { subscribe(l: (line: string) => void): () => void; isStpEnabled(): boolean } }).getDebugService?.();
    this.attachDebugSource(dbg);
    if (input.trim() === '') return this.drainDebugConsole();
    const before = dbg?.isStpEnabled() ? new Map(sw._getSTPStates()) : null;
    let out = this.executeOnDevice(sw, input) as string;
    if (before) {
      const events = this.stpDebugEvents(sw, before);
      if (events) out = out ? `${out}\n${events}` : events;
    }
    return out;
  }

  private stpDebugEvents(sw: Switch, before: Map<string, import('../../devices/Switch').STPPortState>): string {
    const stamp = new Date().toISOString().slice(11, 19);
    const lines: string[] = [];
    for (const [port, state] of sw._getSTPStates()) {
      if (before.get(port) === state) continue;
      const cfg = sw.getSwitchportConfig(port);
      const vlan = cfg && cfg.mode !== 'trunk' ? cfg.accessVlan : 1;
      lines.push(`*${stamp}: STP: VLAN${String(vlan).padStart(4, '0')} ${this.abbreviateInterface(port)} -> ${state}`);
    }
    return lines.join('\n');
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
      case 'config-dhcp': return this.configDhcpTrie;
      default:            return this.userTrie;
    }
  }

  protected clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedInterfaceRange') this.selectedInterfaceRange = [];
      if (f === 'selectedVlan') this.selectedVlan = null;
      if (f === 'selectedAcl') { this.selectedAcl = null; this.selectedArpAcl = null; }
      if (f === 'selectedDhcpPool') this.selectedDhcpPool = null;
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
    this.registerMonitorSessionCommands();
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
    this.registerL3Commands();
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.register('show ip interface brief', 'Display IP interface brief', () =>
        this.showIpInterfaceBrief());
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
    this.configIfTrie.registerGreedy('mtu', 'Set MTU', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(n) || n < 64 || n > 9216) return "% Invalid input detected at '^' marker.";
      const ifs = this.selectedInterface ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const port = this.d().getPort(i);
        if (port) (port as unknown as { setMTU?: (m: number) => void }).setMTU?.(n);
      }
      return '';
    });
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
          const negotiation = s.adminMode === 'access' || s.adminMode === 'nonegotiate' ? 'off' : 'on';
          lines.push(
            `${this.abbreviateInterface(p).padEnd(16)}${this.dtpAdminLabel(s.adminMode).padEnd(17)}` +
            `${s.operationalMode.padEnd(15)}${negotiation}`,
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

    // ── SVI (management Vlan interface) L3 addressing ──
    // L2-only switch: physical ports cannot hold an IP. A management SVI
    // (interface Vlan N) may, mirroring a real Layer-2 switch.
    this.configIfTrie.registerGreedy('ip address', 'Set the SVI IP address', (args) => {
      const iface = this.selectedInterface ?? '';
      const vlan = this.sviVlanId(iface);
      if (vlan === null) {
        return '% IP addresses may not be configured on L2 links.';
      }
      if (args.length < 2 || !IPAddress.isValid(args[0]) || !IPAddress.isValid(args[1])) {
        return "% Invalid input detected at '^' marker.";
      }
      this.d().configureSviIp(vlan, new IPAddress(args[0]), new SubnetMask(args[1]));
      return '';
    });
    this.configIfTrie.register('no ip address', 'Remove the SVI IP address', () => {
      const vlan = this.sviVlanId(this.selectedInterface ?? '');
      if (vlan !== null) this.d().clearSviIp(vlan);
      return '';
    });

    // DHCP relay (`ip helper-address X`) — valid on SVI only. Each
    // helper is appended; `no ip helper-address X` removes one.
    this.configIfTrie.registerGreedy('ip helper-address',
      'Set a DHCP relay target on this SVI', (args) => {
        const vlan = this.sviVlanId(this.selectedInterface ?? '');
        if (vlan === null) return '% Command rejected: not applicable on this interface.';
        if (args.length < 1 || !IPAddress.isValid(args[0])) {
          return "% Invalid input detected at '^' marker.";
        }
        this.d().addSviHelperAddress(vlan, args[0]);
        return '';
      });
    this.configIfTrie.registerGreedy('no ip helper-address',
      'Remove a DHCP relay target from this SVI', (args) => {
        const vlan = this.sviVlanId(this.selectedInterface ?? '');
        if (vlan === null) return '';
        if (args.length >= 1) this.d().removeSviHelperAddress(vlan, args[0]);
        return '';
      });

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
      t.register('show vtp password', 'Display the VTP password', () => {
        const cfg = this.d().getVtpAgent().getConfig();
        return cfg.password
          ? `VTP Password: ${cfg.password}`
          : 'The VTP password is not configured.';
      });
      t.register('show vtp status', 'Display VTP status', () => {
        const cfg = this.d().getVtpAgent().getConfig();
        const numVlans = this.d().getVLANs().size;
        return [
          `VTP Version capable             : 1 to 2`,
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
        const vlan = parseInt(args[1] ?? '', 10);
        const knob = args[2].toLowerCase();
        const n = parseInt(args[3] ?? '', 10);
        const agent = this.d().getStpAgent();
        if (isNaN(vlan)) return "% Invalid input detected at '^' marker.";
        if (knob === 'priority' && !isNaN(n)) agent.setVlanPriority(vlan, n);
        else if (knob === 'hello-time' && !isNaN(n)) agent.setVlanHelloSec(vlan, n);
        else if (knob === 'max-age' && !isNaN(n)) agent.setVlanMaxAgeSec(vlan, n);
        else if (knob === 'forward-time' && !isNaN(n)) agent.setVlanForwardDelaySec(vlan, n);
        else if (knob === 'root') {
          const kind = args[3]?.toLowerCase();
          if (kind === 'primary') agent.setVlanPriority(vlan, 24576);
          else if (kind === 'secondary') agent.setVlanPriority(vlan, 28672);
        }
      }
      if (args[0]?.toLowerCase() === 'priority') {
        const n = parseInt(args[1] ?? '', 10);
        if (!isNaN(n)) this.d().getStpAgent().setBridgePriority(n);
      }
      if (args[0]?.toLowerCase() === 'portfast') {
        const sub = args[1]?.toLowerCase();
        const agent = this.d().getStpAgent();
        if (sub === 'default') agent.setPortfastDefault(true);
        else if (sub === 'bpduguard' && args[2]?.toLowerCase() === 'default') agent.setBpduGuardGlobal(true);
        else if (sub === 'bpdufilter' && args[2]?.toLowerCase() === 'default') agent.setBpduFilterGlobal(true);
      }
      if (args[0]?.toLowerCase() === 'loopguard' && args[1]?.toLowerCase() === 'default') {
        this.d().getStpAgent().setLoopGuardGlobal(true);
      }
      if (args[0]?.toLowerCase() === 'uplinkfast') this.d().getStpAgent().setUplinkFast(true);
      if (args[0]?.toLowerCase() === 'backbonefast') this.d().getStpAgent().setBackboneFast(true);
      if (args[0]?.toLowerCase() === 'pathcost' && args[1]?.toLowerCase() === 'method') {
        const m = args[2]?.toLowerCase();
        if (m !== 'long' && m !== 'short') return "% Invalid input detected at '^' marker.";
        this.d().getStpAgent().setPathcostMethod(m);
      }
      return '';
    });
    this.configTrie.registerGreedy('spanning-tree mst', 'MST instance configuration', (args) => {
      if (args[1]?.toLowerCase() === 'priority') {
        const inst = parseInt(args[0] ?? '', 10);
        const prio = parseInt(args[2] ?? '', 10);
        if (isNaN(inst) || isNaN(prio)) return "% Invalid input detected at '^' marker.";
        this.d().getStpAgent().setMstInstancePriority(inst, prio);
      }
      return '';
    });
    this.configTrie.registerGreedy('no spanning-tree', 'Disable spanning-tree', (args) => {
      const agent = this.d().getStpAgent();
      const a0 = args[0]?.toLowerCase();
      if (a0 === 'vlan' && args[1]) agent.setEnabled(false);
      else if (a0 === 'portfast') {
        const sub = args[1]?.toLowerCase();
        if (sub === 'default') agent.setPortfastDefault(false);
        else if (sub === 'bpduguard') agent.setBpduGuardGlobal(false);
        else if (sub === 'bpdufilter') agent.setBpduFilterGlobal(false);
      } else if (a0 === 'loopguard') agent.setLoopGuardGlobal(false);
      else if (a0 === 'uplinkfast') agent.setUplinkFast(false);
      else if (a0 === 'backbonefast') agent.setBackboneFast(false);
      else if (a0 === 'pathcost') agent.setPathcostMethod('short');
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
    this.configMstTrie.register('show current', 'Show current MST config', () =>
      this.showMstConfig());
    this.configMstTrie.register('show pending', 'Show pending MST config', () =>
      this.showMstConfig());
    // The base redirects `show …` in config modes to the privileged
    // trie, so `show current` must also resolve there.
    this.privilegedTrie.register('show current', 'Show current MST config', () =>
      this.showMstConfig());
    this.privilegedTrie.register('show pending', 'Show pending MST config', () =>
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
        const ports = sw._getPortsInternal();
        const isRoot = agent?.isRoot() ?? false;
        const rootForVlan = isRoot ? 'VLAN0001' : 'none';
        let blocking = 0, listening = 0, learning = 0, forwarding = 0;
        for (const [name, state] of stpStates) {
          const port = ports.get(name);
          if (!port || !port.getIsUp() || !port.isConnected()) continue;
          if (state === 'blocking') blocking++;
          else if (state === 'listening') listening++;
          else if (state === 'learning') learning++;
          else if (state === 'forwarding') forwarding++;
        }
        const total = blocking + listening + learning + forwarding;
        const g = agent?.getGlobalStp();
        const onOff = (b: boolean | undefined) => (b ? 'is enabled' : 'is disabled');
        return [
          `Switch is in ${this.stpMode} mode`,
          `Root bridge for: ${rootForVlan}`,
          `Extended system ID           is enabled`,
          `Portfast Default             ${onOff(g?.portfastDefault)}`,
          `PortFast BPDU Guard Default  ${onOff(g?.bpduGuardGlobal)}`,
          `Portfast BPDU Filter Default ${onOff(g?.bpduFilterGlobal)}`,
          `Loopguard Default            ${onOff(g?.loopGuardGlobal)}`,
          `UplinkFast                   ${onOff(g?.uplinkFast)}`,
          `BackboneFast                 ${onOff(g?.backboneFast)}`,
          `Configured Pathcost method used is ${agent?.getPathcostMethod() ?? 'short'}`,
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
      t.register('show spanning-tree active', 'STP state on active interfaces', () =>
        this.showSpanningTree(this.d()));
      t.register('show spanning-tree pathcost method', 'STP default path-cost method', () =>
        `Spanning tree default pathcost method used is ${this.stpAgentOf(this.d())?.getPathcostMethod() ?? 'short'}`);
      t.registerGreedy('show spanning-tree mst', 'MST instance state', (a) => {
        if (a[0]?.toLowerCase() === 'configuration') return this.showMstConfig();
        if (!a[0]) return this.showMstInstances();
        const id = parseInt(a[0], 10);
        if (isNaN(id)) return "% Invalid input detected at '^' marker.";
        return this.showMstInstances(id);
      });
    }
    this.registerSwitchDebugCommands();
  }

  private registerSwitchDebugCommands(): void {
    const p = this.privilegedTrie;
    const svc = () => this.switchDebug();
    const guard = (raw: string): boolean => /[A-Z]/.test((raw.trim().split(/\s+/)[0]) ?? '');

    p.register('show debugging', 'Display active debugging', () =>
      this.mode === 'user' ? "% Invalid input detected at '^' marker." : (svc()?.format() ?? 'No debugging is enabled'));

    p.register('debug all', 'Enable all debugging', () => svc()?.enableAll() ?? 'All possible debugging is on');
    p.registerGreedy('debug spanning-tree', 'Enable STP debugging', (a) => {
      const what = a.join(' ') || 'all';
      svc()?.enable('spanning-tree ' + what);
      return `Spanning Tree ${what} debugging is on`;
    });
    p.registerGreedy('debug mac address-table', 'Enable MAC table debugging', () => svc()?.enable('mac') ?? '');
    p.registerGreedy('debug mac-address-table', 'Enable MAC table debugging', () => svc()?.enable('mac') ?? '');
    p.registerGreedy('debug link-state', 'Enable link-state debugging', () => svc()?.enable('link') ?? '');
    p.registerGreedy('debug', 'Enable debugging', (a, raw) => {
      if (guard(raw ?? '')) return "% Invalid input detected at '^' marker.";
      const arg = a.join(' ');
      const service = svc();
      if (!service || !service.recognizes(arg)) return "% Invalid input detected at '^' marker.";
      return service.enable(arg);
    });

    p.register('no debug all', 'Disable all debugging', () => svc()?.disableAll() ?? 'All possible debugging has been turned off');
    p.register('undebug all', 'Disable all debugging', () => svc()?.disableAll() ?? 'All possible debugging has been turned off');
    p.registerGreedy('no debug spanning-tree', 'Disable STP debugging', (a) => {
      const what = a.join(' ') || 'all';
      svc()?.disable('spanning-tree ' + what);
      return `Spanning Tree ${what} debugging is off`;
    });
    p.registerGreedy('no debug mac address-table', 'Disable MAC table debugging', () => svc()?.disable('mac') ?? '');
    p.registerGreedy('no debug link-state', 'Disable link-state debugging', () => svc()?.disable('link') ?? '');
    const undebugScope = (arg: string): string => {
      const service = svc();
      if (!service) return '';
      if (arg.trim() === '' || arg.trim() === 'all') return service.disableAll();
      if (!service.recognizes(arg)) return "% Invalid input detected at '^' marker.";
      return service.disable(arg);
    };
    p.registerGreedy('undebug', 'Disable debugging', (a) => undebugScope(a.join(' ')));
  }

  private switchDebug(): import('../switch/SwitchDebugService').SwitchDebugService | undefined {
    return (this.d() as unknown as { getDebugService?: () => import('../switch/SwitchDebugService').SwitchDebugService }).getDebugService?.();
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

  private showMstInstances(filter?: number): string {
    const sw = this.d();
    const agent = this.stpAgentOf(sw);
    if (!agent) return '';
    const region = agent.getMstRegion();
    const mac = this.formatMacCisco(new MACAddress(agent.ownBridgeId().mac));
    const ports = sw._getPortsInternal();
    const ids = [0, ...[...region.instances.keys()].sort((a, b) => a - b)];
    const blocks: string[] = [];
    for (const id of ids) {
      if (filter !== undefined && id !== filter) continue;
      const mapped = id === 0
        ? (region.instances.size ? 'all VLANs not explicitly mapped' : '1-4094')
        : (region.instances.get(id) ?? '');
      const prio = agent.getMstInstancePriority(id);
      const block = [
        `##### MST${id}    vlans mapped:   ${mapped}`,
        `Bridge        address ${mac}  priority  ${prio + id} (${prio} sysid ${id})`,
        '',
        'Interface        Role  Sts  Cost      Prio.Nbr  Type',
        '---------------- ----  ---  --------  --------  ----',
      ];
      let idx = 0;
      for (const name of sw.getPortNames()) {
        idx += 1;
        const port = ports.get(name);
        if (!port || !port.getIsUp() || !port.isConnected()) continue;
        const role = agent.getPortRole(name);
        const roleLabel = role === 'root' ? 'Root' : role === 'alternate' ? 'Altn'
          : role === 'backup' ? 'Back' : 'Desg';
        const sts = sw._getSTPStates().get(name) === 'forwarding' ? 'FWD' : 'BLK';
        const cost = agent.getPortCost(name);
        const linkType = agent.getPortLinkType(name) === 'shared' ? 'Shr' : 'P2p';
        block.push(`${this.abbreviateInterface(name).padEnd(17)}${roleLabel.padEnd(6)}${sts.padEnd(5)}${String(cost).padEnd(10)}${`128.${idx}`.padEnd(10)}${linkType}`);
      }
      blocks.push(block.join('\n'));
    }
    if (filter !== undefined && blocks.length === 0) {
      return `% MST instance ${filter} is not configured`;
    }
    return blocks.join('\n\n');
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
      return showSwitchVersion(this.d());
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

    this.userTrie.registerGreedy('ping', 'Send echo messages', (args) => this.handlePing(args));
  }

  /**
   * Drive a management-plane ping from an SVI. Uses the shared async pipeline
   * (`_pendingAsync`) and the shared IOS renderer, exactly like the router.
   */
  private handlePing(args: string[]): string {
    const parsed = parsePingArgs(args);
    if (parsed.error) return parsed.error;
    const target = new IPAddress(parsed.target);
    this._pendingAsync = this.d()
      .executePingSequence(target, parsed.count, parsed.timeoutMs, parsed.sourceIP ?? undefined)
      .then(results => formatCiscoPing(parsed.target, parsed.count, parsed.timeoutMs, results, parsed.sizeBytes));
    return '';
  }

  // ─── Privileged Commands ──────────────────────────────────────────

  private registerPrivilegedCommands(): void {
    this.privilegedTrie.registerGreedy('ping', 'Send echo messages', (args) => this.handlePing(args));

    this.privilegedTrie.registerGreedy('show mac address-table', 'Display MAC address table', (args) => {
      const full = this.showMACAddressTable(this.d());
      const a = args.map(x => x.toLowerCase());
      let i = 0;
      if (a[i] === 'dynamic' || a[i] === 'static' || a[i] === 'multicast') i++;
      if (a[i] === 'vlan' && a[i + 1]) {
        const lines = full.split('\n');
        return [lines[0] ?? '', ...lines.filter(l => new RegExp(`\\b${args[i + 1]}\\b`).test(l))].join('\n');
      }
      if (a[i] === 'interface' && a[i + 1]) {
        const lines = full.split('\n');
        return [lines[0] ?? '', ...lines.filter(l => l.includes(args[i + 1]))].join('\n');
      }
      if (a[i] === 'address' && a[i + 1]) {
        const lines = full.split('\n');
        return [lines[0] ?? '', ...lines.filter(l => l.includes(args[i + 1]))].join('\n');
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
      return this.showTrunkTable(this.d().getPortNames());
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
        if (target) {
          const name = this.resolveInterfaceName(target);
          if (!name || !this.d().getPort(name)) {
            return `% Invalid input detected at '^' marker.\nshow interfaces ${args.join(' ')}\n                ^`;
          }
          return this.showInterfacesCounters(name);
        }
        return this.showInterfacesCounters(null);
      }
      if (last === 'description') return this.showInterfacesDescriptionTable();
      if (last === 'trunk' && args.length > 1) {
        const name = this.resolveInterfaceName(args.slice(0, -1).join(' '));
        if (!name || !this.d().getPort(name)) {
          return `% Invalid input detected at '^' marker.\nshow interfaces ${args.join(' ')}\n                ^`;
        }
        return this.showTrunkTable([name]);
      }
      if (args.length === 1 && 'status'.startsWith(last) && last.length >= 3) return this.showInterfacesStatus(this.d());
      const name = this.resolveInterfaceName(args.join(' '));
      if (name && this.d().getPort(name)) return showInterface(this.d(), name);
      return `% Invalid input detected at '^' marker.\nshow interfaces ${args.join(' ')}\n                ^`;
    });

    this.privilegedTrie.register('show vlan summary', 'Display VLAN count summary', () => {
      const ids = [...this.d().getVLANs().keys()];
      const extended = ids.filter((id) => id >= 1006).length;
      const normal = ids.length - extended;
      return [
        `Number of existing VLANs          : ${ids.length}`,
        `Number of existing VTP VLANs      : ${normal}`,
        `Number of existing extended VLANs : ${extended}`,
      ].join('\n');
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
        if (cfg.voiceVlan !== undefined) out.push(` switchport voice vlan ${cfg.voiceVlan}`);
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
      return startup ? startup : '% startup-config is not present';
    });

    this.privilegedTrie.register('write', 'Save running-config to startup-config', () => {
      return this.d().writeMemory();
    });

    this.privilegedTrie.register('show version', 'Display system information', () => {
      return showSwitchVersion(this.d());
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
        const vlan = this.sviVlanId(virt);
        if (vlan !== null) {
          if (vlan < 1 || vlan > 4094) return "% Invalid input detected at '^' marker.";
          this.d().ensureSvi(vlan);
        }
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

    // ── Management plane: SSH host keys, domain, default-gateway ──
    this.configTrie.registerGreedy('crypto key generate rsa', 'Generate RSA host keys', () => {
      if (!this.d().getDomainName()) {
        return '% Please define a domain-name first.';
      }
      this.d()._generateRsaKeys();
      const fqdn = `${this.d().getHostname()}.${this.d().getDomainName()}`;
      return [
        `The name for the keys will be: ${fqdn}`,
        '% The key modulus size is 512 bits',
        '% Generating 512 bit RSA keys, keys will be non-exportable...[OK]',
        'RSA key pair generated',
      ].join('\n');
    });
    this.configTrie.registerGreedy('crypto key zeroize rsa', 'Delete RSA host keys', () => {
      return '% Keys to be removed are named ' + `${this.d().getHostname()}.${this.d().getDomainName()}` + '.';
    });
    this.configTrie.registerGreedy('ip ssh version', 'Set the SSH version', () => {
      // SSH requires RSA host keys (`crypto key generate rsa`) first — IOS
      // refuses to bring SSH up without them.
      if (!this.d().hasRsaKeys()) {
        return 'Please create RSA keys to enable SSH (and of at least 768 bits for SSH v2).';
      }
      return '';
    });
    this.configTrie.registerGreedy('ip default-gateway', 'Set the management default gateway', (args) => {
      if (!args[0] || !IPAddress.isValid(args[0])) return "% Invalid input detected at '^' marker.";
      this.d()._setDefaultGateway(args[0]);
      return '';
    });
    this.configTrie.register('no ip default-gateway', 'Remove the management default gateway', () => {
      this.d()._setDefaultGateway('');
      return '';
    });

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

  private registerMonitorSessionCommands(): void {
    this.configTrie.registerGreedy('monitor session', 'Configure SPAN session', (args) =>
      this.handleMonitorSession(args, false));
    this.configTrie.registerGreedy('no monitor session', 'Delete a SPAN session', (args) =>
      this.handleMonitorSession(args, true));

    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.register('show monitor', 'Display SPAN sessions', () => this.showMonitor(null));
      t.registerGreedy('show monitor session', 'Display SPAN session(s)', (args) => {
        if (args.length === 0 || args[0].toLowerCase() === 'all') return this.showMonitor(null);
        const id = parseInt(args[0], 10);
        if (Number.isNaN(id)) return '% Invalid session id.';
        return this.showMonitor(id);
      });
    }
  }

  private handleMonitorSession(args: string[], negate: boolean): string {
    if (args.length < 1) return '% Incomplete command.';
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id) || id < 1 || id > 66) return '% Invalid session id.';
    const dev = this.d();

    if (negate && args.length === 1) {
      return dev.removeMirrorSession(id) ? '' : `% Session ${id} does not exist.`;
    }

    const verb = (args[1] ?? '').toLowerCase();
    if (verb === 'source') {
      const ifaceArg = args[2] === 'interface' ? args[3] : null;
      if (!ifaceArg) return '% Incomplete command.';
      const portName = this.resolveInterfaceName(ifaceArg);
      if (!portName || !dev.getPort(portName)) return `% Invalid interface name "${ifaceArg}"`;
      if (dev.getPortMirror().isDestination(portName)) {
        return `% Cannot add source — ${portName} is already a SPAN destination.`;
      }
      const dirTok = (args[4] ?? 'both').toLowerCase();
      if (dirTok !== 'rx' && dirTok !== 'tx' && dirTok !== 'both') {
        return '% Invalid direction (rx | tx | both).';
      }
      if (negate) return dev.removeMirrorSource(id, portName) ? '' : `% Source ${portName} not configured.`;
      dev.configureMirrorSource(id, portName, dirTok);
      return '';
    }

    if (verb === 'destination') {
      const ifaceArg = args[2] === 'interface' ? args[3] : null;
      if (!ifaceArg) return '% Incomplete command.';
      const portName = this.resolveInterfaceName(ifaceArg);
      if (!portName || !dev.getPort(portName)) return `% Invalid interface name "${ifaceArg}"`;
      const session = dev.getMirrorSession(id);
      if (session && [...session.sources.keys()].includes(portName)) {
        return `% Cannot set destination — ${portName} is already a source for session ${id}.`;
      }
      if (negate) return dev.removeMirrorDestination(id) ? '' : `% Destination not configured.`;
      dev.configureMirrorDestination(id, portName);
      return '';
    }

    return "% Invalid input detected at '^' marker.";
  }

  private showMonitor(only: number | null): string {
    const sessions = this.d().listMirrorSessions();
    if (sessions.length === 0) return '';
    if (only === null) {
      return sessions.map((s) => this.d().getPortMirror().formatOne(s.id)).join('\n\n');
    }
    if (!sessions.find((s) => s.id === only)) return `% Session ${only} does not exist.`;
    return this.d().getPortMirror().formatOne(only);
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
      const verb = line.split(' ').slice(0, 3).join(' ');
      for (const i of ifs) {
        const l = (this.ifExtra.get(i) ?? []).filter(
          (existing) => existing.split(' ').slice(0, 3).join(' ') !== verb);
        l.push(line);
        this.ifExtra.set(i, l);
      }
      return '';
    };
    this.configIfTrie.registerGreedy('switchport trunk encapsulation', 'Trunk encapsulation', (args) => {
      if (this.selectedInterface && this.sviVlanId(this.selectedInterface) !== null) {
        return "% Invalid input detected at '^' marker.";
      }
      const t = (args[0] ?? '').toLowerCase();
      if (t !== 'dot1q' && t !== 'negotiate') {
        return `% ${args[0]} encapsulation is not supported on this platform`;
      }
      return recordIf(`switchport trunk encapsulation ${args.join(' ')}`.trim());
    });
    for (const sub of [
      'switchport voice', 'switchport priority',
      'channel-protocol', 'storm-control', 'mls qos',
      'speed', 'duplex', 'mdix', 'power', 'srr-queue', 'load-interval',
    ]) {
      this.configIfTrie.registerGreedy(sub, `Interface ${sub}`, (args) => {
        // These are physical-port-only; an SVI is a virtual L3 interface and
        // rejects them just like real IOS does.
        if (this.selectedInterface && this.sviVlanId(this.selectedInterface) !== null) {
          return "% Invalid input detected at '^' marker.";
        }
        return recordIf(`${sub} ${args.join(' ')}`.trim());
      });
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
    this.configIfTrie.registerGreedy('switchport voice vlan', 'Set the voice VLAN', (args) => {
      if (!args[0]) return '% Incomplete command.';
      const kw = args[0].toLowerCase();
      const v = parseInt(args[0], 10);
      if (kw !== 'dot1p' && kw !== 'none' && kw !== 'untagged' && (isNaN(v) || v < 1 || v > 4094)) {
        return "% Invalid input detected at '^' marker.";
      }
      const ifs = this.selectedInterface ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const cfg = this.d().getSwitchportConfig(i);
        if (cfg) cfg.voiceVlan = isNaN(v) ? undefined : v;
      }
      return '';
    });
    this.configIfTrie.register('no switchport voice vlan', 'Remove voice VLAN', () => {
      const ifs = this.selectedInterface ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const cfg = this.d().getSwitchportConfig(i);
        if (cfg) cfg.voiceVlan = undefined;
      }
      return removeIf('switchport voice');
    });

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
      return this.applyToSelectedInterfaces(portName => this.setIfAdminState(portName, false));
    });

    this.configIfTrie.register('no shutdown', 'Enable interface', () => {
      return this.applyToSelectedInterfaces(portName => this.setIfAdminState(portName, true));
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

    if (sw.getDomainName()) { lines.push(`ip domain-name ${sw.getDomainName()}`); lines.push('!'); }
    if (sw.getDefaultGateway()) { lines.push(`ip default-gateway ${sw.getDefaultGateway()}`); lines.push('!'); }

    // Local AAA users (`username NAME privilege N secret …`).
    const users = sw._listLocalUsers().filter(u => !u.factoryDefault);
    if (users.length > 0) {
      for (const u of users) {
        const field = u.secretAlgo === 'type-7'
          ? `password ${renderPasswordField(u.secret, 'type-7', false)}`
          : `secret ${renderSecretField(u.secret, u.secretAlgo)}`;
        lines.push(`username ${u.name} privilege ${u.privilege} ${field}`);
      }
      lines.push('!');
    }

    // VTY line configuration (transport input, login, password, …).
    const vtyLines = sw._getVtyLineConfig().renderAllCisco();
    if (vtyLines.length > 0) { lines.push(...vtyLines); lines.push('!'); }

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
      if (cfg.voiceVlan !== undefined) lines.push(` switchport voice vlan ${cfg.voiceVlan}`);
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

    // SVI (interface Vlan N) blocks — IP address, helper-address, admin
    // state. Rendered after the physical interfaces so the running-config
    // mirrors how real IOS prints it.
    for (const svi of sw.getSvis()) {
      lines.push(`interface Vlan${svi.vlan}`);
      if (svi.ip && svi.mask) {
        lines.push(` ip address ${svi.ip} ${svi.mask}`);
      } else {
        lines.push(' no ip address');
      }
      for (const helper of svi.helperAddresses) {
        lines.push(` ip helper-address ${helper}`);
      }
      if (!svi.adminUp) lines.push(' shutdown');
      lines.push('!');
    }

    // Static routes (`ip route NET MASK GW`).
    for (const r of sw.getL3RoutingTable()) {
      if (r.proto !== 'static' || !r.nextHop) continue;
      lines.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
    }

    for (const l of this.logging.asRunningConfigLines()) lines.push(l);

    const unhandled = (sw as unknown as { getUnhandledConfigLines?: () => readonly string[] }).getUnhandledConfigLines?.() ?? [];
    if (unhandled.length > 0) {
      lines.push('!');
      lines.push(...unhandled);
    }

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

  private showTrunkTable(portNames: string[]): string {
    const sw = this.d();
    const dtp = sw.getDtpAgent();
    const existing = [...sw.getVLANs().keys()].sort((a, b) => a - b);
    const trunks: Array<{ port: string; native: number; allowed: Set<number> }> = [];
    for (const p of portNames) {
      const c = sw.getSwitchportConfig(p);
      if (c && dtp.getOperationalMode(p) === 'trunk') {
        trunks.push({ port: this.abbreviateInterface(p), native: c.trunkNativeVlan, allowed: c.trunkAllowedVlans });
      }
    }
    const lines = ['Port        Mode             Encapsulation  Status        Native vlan'];
    for (const t of trunks) {
      lines.push(`${t.port.padEnd(12)}${'on'.padEnd(17)}${'802.1q'.padEnd(15)}${'trunking'.padEnd(14)}${t.native}`);
    }
    if (trunks.length === 0) return lines.join('\n');
    const allowedStr = (a: Set<number>) =>
      a.size >= 4094 ? '1-4094' : this.compactVlanList([...a].sort((x, y) => x - y));
    const activeStr = (a: Set<number>) =>
      this.compactVlanList(existing.filter((v) => a.has(v))) || 'none';
    lines.push('', 'Port        Vlans allowed on trunk');
    for (const t of trunks) lines.push(`${t.port.padEnd(12)}${allowedStr(t.allowed)}`);
    lines.push('', 'Port        Vlans allowed and active in management domain');
    for (const t of trunks) lines.push(`${t.port.padEnd(12)}${activeStr(t.allowed)}`);
    lines.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
    for (const t of trunks) lines.push(`${t.port.padEnd(12)}${activeStr(t.allowed)}`);
    return lines.join('\n');
  }

  private showSwitchportDetail(name: string): string {
    const c = this.d().getSwitchportConfig(name);
    const dtp = this.d().getDtpAgent();
    const admin = dtp.getAdminMode(name);
    const oper = dtp.getOperationalMode(name);
    const adminLabel =
      admin === 'trunk' || admin === 'nonegotiate' ? 'trunk'
      : admin === 'dynamic-auto' ? 'dynamic auto'
      : admin === 'dynamic-desirable' ? 'dynamic desirable'
      : 'static access';
    const operLabel = oper === 'trunk' ? 'trunk' : 'static access';
    const negotiation = admin === 'access' || admin === 'nonegotiate' ? 'Off' : 'On';
    const nativeVlan = c?.trunkNativeVlan ?? 1;
    const lines = [
      `Name: ${this.abbreviateInterface(name)}`,
      `Switchport: Enabled`,
      `Administrative Mode: ${adminLabel}`,
      `Operational Mode: ${operLabel}`,
      `Administrative Trunking Encapsulation: dot1q`,
      `Negotiation of Trunking: ${negotiation}`,
      `Access Mode VLAN: ${c?.accessVlan ?? 1} (${this.d().getVLANs().get(c?.accessVlan ?? 1)?.name ?? 'default'})`,
      `Trunking Native Mode VLAN: ${nativeVlan}${nativeVlan === 1 ? ' (default)' : ''}`,
    ];
    if (oper === 'trunk') {
      const allowed = !c || c.trunkAllowedVlans.size >= 4094
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

      lines.push(`${shortName}${desc}${status}${vlanStr.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(7)}${type}`);
    }

    return lines.join('\n');
  }

  private showSpanningTree(sw: Switch, vlanId = 1): string {
    const stpStates = sw._getSTPStates();
    const agent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
    const root = agent?.getRootBridgeForVlan(vlanId);
    const cost = agent?.getRootPathCostForVlan(vlanId) ?? 0;
    const rootPort = agent?.getRootPortForVlan(vlanId);
    const isRoot = agent?.isRootForVlan(vlanId) ?? true;
    const rootMacFmt = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const rootPrio = (isRoot ? (agent?.getVlanPriority(vlanId) ?? 32768) : (root?.priority ?? 32768)) + vlanId;
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
    const portIndex = new Map<string, number>();
    let idx = 0;
    for (const name of sw.getPortNames()) { idx += 1; portIndex.set(name, idx); }
    const ports = sw._getPortsInternal();
    for (const [portName] of stpStates) {
      const port = ports.get(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (!sw.getStpPortVlans(portName).includes(vlanId)) continue;
      const state = agent?.getForwardStateForVlan(vlanId, portName) ?? sw.getStpVlanState(portName, vlanId);
      const shortName = this.abbreviateInterface(portName).padEnd(17);
      const stpRole = agent?.getPortRoleForVlan(vlanId, portName) ?? 'designated';
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
      const prioNbr = `128.${portIndex.get(portName) ?? 1}`;
      lines.push(`${shortName}${role.padEnd(6)}${sts.padEnd(5)}${String(portCost).padEnd(10)}${prioNbr.padEnd(10)}${linkType}${edge}`);
    }
    return lines.join('\n');
  }

  private stpAgentOf(sw: Switch) {
    return (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
  }

  private stpSummaryCounts(sw: Switch): string {
    let blk = 0, lis = 0, lrn = 0, fwd = 0;
    const ports = sw._getPortsInternal();
    for (const [name, state] of sw._getSTPStates()) {
      const port = ports.get(name);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
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
    const root = agent?.getRootBridgeForVlan(vlanId);
    const cost = agent?.getRootPathCostForVlan(vlanId) ?? 0;
    const rootPort = agent?.getRootPortForVlan(vlanId);
    const isRoot = agent?.isRootForVlan(vlanId) ?? true;
    const mac = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const prio = (isRoot ? (agent?.getVlanPriority(vlanId) ?? 32768) : (root?.priority ?? 32768)) + vlanId;
    const hello = agent?.getVlanHelloSec(vlanId) ?? 2;
    const maxAge = agent?.getVlanMaxAgeSec(vlanId) ?? 20;
    const fwd = agent?.getVlanForwardDelaySec(vlanId) ?? 15;
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      '                                        Root    Hello Max Fwd',
      'Vlan             Root ID              Cost    Port    Time  Age Dly',
      '---------------- -------------------- ------- ------- ----- --- ---',
      `${vlan.padEnd(17)}${prio} ${mac}  ${String(cost).padEnd(8)}${(rootPort ? this.abbreviateInterface(rootPort) : '').padEnd(8)}${String(hello).padEnd(6)}${String(maxAge).padEnd(4)}${fwd}`,
    ].join('\n');
  }

  private showStpBridge(sw: Switch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const own = agent?.ownBridgeId();
    const mac = own ? this.formatMacCisco(new MACAddress(own.mac)) : '0000.0000.0000';
    const prio = (agent?.getVlanPriority(vlanId) ?? 32768) + vlanId;
    const hello = agent?.getVlanHelloSec(vlanId) ?? 2;
    const maxAge = agent?.getVlanMaxAgeSec(vlanId) ?? 20;
    const fwd = agent?.getVlanForwardDelaySec(vlanId) ?? 15;
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      '                                                   Hello  Max  Fwd',
      'Vlan             Bridge ID                          Time  Age  Dly  Protocol',
      '---------------- ---------------------------------- -----  ---  ---  --------',
      `${vlan.padEnd(17)}${prio} (${prio - vlanId}, ${vlanId})  ${mac}  ${String(hello).padEnd(6)}${String(maxAge).padEnd(5)}${String(fwd).padEnd(5)}ieee`,
    ].join('\n');
  }

  private showStpBlockedPorts(sw: Switch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const blocked: string[] = [];
    for (const [portName] of sw._getSTPStates()) {
      if (!sw.getStpPortVlans(portName).includes(vlanId)) continue;
      const role = agent?.getPortRoleForVlan(vlanId, portName);
      const state = agent?.getForwardStateForVlan(vlanId, portName) ?? sw.getStpVlanState(portName, vlanId);
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
    const isRoot = agent?.isRootForVlan(vlanId) ?? true;
    const root = agent?.getRootBridgeForVlan(vlanId);
    const own = agent?.ownBridgeId(vlanId);
    const cost = agent?.getRootPathCostForVlan(vlanId) ?? 0;
    const rootPort = agent?.getRootPortForVlan(vlanId);
    const rootMac = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const ownMac = own ? this.formatMacCisco(new MACAddress(own.mac)) : '0000.0000.0000';
    const out: string[] = [
      ` VLAN${String(vlanId).padStart(4, '0')} is executing the ${this.stpMode} compatible Spanning Tree protocol`,
      `  Bridge Identifier has priority ${agent?.getVlanPriority(vlanId) ?? 32768}, sysid ${vlanId}, address ${ownMac}`,
      isRoot
        ? '  We are the root of the spanning tree'
        : `  Current root has priority ${root ? root.priority : 32768}, address ${rootMac}`,
      `  Root port is ${rootPort ? this.abbreviateInterface(rootPort) : 'N/A'}, cost of root path is ${cost}`,
      '  Hello Time 2 sec  Max Age 20 sec  Forward Delay 15 sec',
      '',
    ];
    for (const [portName] of sw._getSTPStates()) {
      if (!sw.getStpPortVlans(portName).includes(vlanId)) continue;
      const role = agent?.getPortRoleForVlan(vlanId, portName) ?? 'designated';
      const state = agent?.getForwardStateForVlan(vlanId, portName) ?? sw.getStpVlanState(portName, vlanId);
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
    const compact = input.replace(/\s+/g, '');
    const po = compact.match(/^(?:po|port-?channel)(\d+)$/i);
    if (po) return `Port-channel${po[1]}`;
    // SVI: `interface Vlan N` (the switch's L3 management interface).
    const vl = compact.match(/^(?:vl|vlan)(\d+)$/i);
    if (vl) return `Vlan${vl[1]}`;
    return null;
  }

  /** Extract the VLAN id from an SVI interface name ("Vlan10" → 10). */
  private sviVlanId(iface: string): number | null {
    const m = /^vlan(\d+)$/i.exec(iface);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Wire the IOS Layer-3 surface: `ip routing`, `ip route`, the
   * `ip dhcp pool` sub-mode (reusing the shared DHCP pool builder),
   * `ip dhcp excluded-address`, and the matching show / clear views.
   * Every command targets the Switch's own DHCPServer / SVI routing
   * table — the same machinery that lights up inter-VLAN routing.
   */
  private registerL3Commands(): void {
    const cfg = this.configTrie;

    // `ip routing` / `no ip routing` — global L3 enable (IOS requires
    // it on some 2960 SKUs; we accept it as a no-op since the switch
    // base already routes through its SVI plane).
    cfg.register('ip routing', 'Enable Layer-3 routing', () => '');
    cfg.register('no ip routing', 'Disable Layer-3 routing', () => '');

    // ip route <net> <mask> <next-hop>
    cfg.registerGreedy('ip route', 'Add a static route', (args) => {
      if (args.length < 3) return '% Incomplete command.';
      let net: IPAddress, mask: SubnetMask, gw: IPAddress;
      try { net = new IPAddress(args[0]); } catch { return `% Invalid network ${args[0]}`; }
      try { mask = new SubnetMask(args[1]); } catch { return `% Invalid mask ${args[1]}`; }
      try { gw = new IPAddress(args[2]); } catch { return `% Invalid next-hop ${args[2]}`; }
      this.d().addStaticRoute(net, mask, gw);
      return '';
    });
    cfg.registerGreedy('no ip route', 'Remove a static route', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      let net: IPAddress, mask: SubnetMask;
      try { net = new IPAddress(args[0]); } catch { return `% Invalid network ${args[0]}`; }
      try { mask = new SubnetMask(args[1]); } catch { return `% Invalid mask ${args[1]}`; }
      this.d().removeStaticRoute(net, mask);
      return '';
    });

    // ip dhcp pool <name> → enter dhcp-config view, reuse shared builder
    cfg.registerGreedy('ip dhcp pool', 'Define a DHCP address pool', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const dhcp = this.d()._getDHCPServerInternal();
      if (!dhcp.getPool(args[0])) dhcp.createPool(args[0]);
      dhcp.enable(); // IOS auto-enables the DHCP service when a pool is created
      this.selectedDhcpPool = args[0];
      this.mode = 'config-dhcp';
      return '';
    });
    cfg.registerGreedy('no ip dhcp pool', 'Remove a DHCP pool', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.d()._getDHCPServerInternal().deletePool(args[0]);
      return '';
    });
    cfg.registerGreedy('ip dhcp excluded-address',
      'Exclude IP range from DHCP allocation', (args) => {
        if (args.length < 1) return '% Incomplete command.';
        this.d()._getDHCPServerInternal().addExcludedRange(args[0], args[1] || args[0]);
        return '';
      });

    // Pool sub-mode trie: reuse the shared Cisco builder. Only the
    // handful of accessors the pool commands actually call need to be
    // populated; the rest of CiscoShellContext is irrelevant on a
    // switch (no IPSec / routing-proto state here).
    const dhcpCtx = {
      r: () => this.d() as unknown as Router,
      setMode: (m: string) => { this.mode = m as CLIMode; },
      getSelectedDHCPPool: () => this.selectedDhcpPool,
      setSelectedDHCPPool: (p: string | null) => { this.selectedDhcpPool = p; },
    } as unknown as CiscoShellContext;
    buildConfigDhcpCommands(this.configDhcpTrie, dhcpCtx);

    // ── Show commands ──────────────────────────────────────────────
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.registerGreedy('show ip route', 'Display IP routing table', () =>
        this.showIpRoute());
      t.registerGreedy('show ip dhcp binding', 'Display DHCP bindings', () =>
        this.showIpDhcpBinding());
      t.registerGreedy('show ip dhcp pool', 'Display DHCP pools', () =>
        this.showIpDhcpPool());
      t.register('show arp', 'Display ARP cache', () => this.showArp());
      t.register('show ip arp', 'Display IP ARP cache', () => this.showArp());
      t.registerGreedy('show ip interface', 'Display verbose L3 state per interface', (args) => {
        if (args.length === 0 || args[0]?.toLowerCase() === 'brief') {
          return this.showIpInterfaceBrief();
        }
        return this.showIpInterfaceVerbose(args.join(' '));
      });
    }
  }

  /**
   * IOS `show ip interface Vlan<N>` — the verbose per-SVI L3 view used
   * for sanity checks: IP/mask, MTU, MAC, broadcast, line/protocol
   * state, and the configured `ip helper-address` list. Falls back to a
   * "% Invalid interface" for non-SVI names since L2 ports carry no IP.
   */
  private showIpInterfaceVerbose(iface: string): string {
    const vlanIfMatch = iface.match(/^(?:vl|vlan)\s*(\d+)$/i);
    if (!vlanIfMatch) {
      return `% Invalid input detected at '^' marker.`;
    }
    const vlan = parseInt(vlanIfMatch[1], 10);
    const svi = this.d().getSvi(vlan);
    if (!svi) return `Vlan${vlan} is administratively down, line protocol is down (svi not configured)`;

    const adminUp = svi.adminUp;
    const lineUp = adminUp && this.d().isSviLineUp(svi);
    const stateLine = `Vlan${vlan} is ${adminUp ? (lineUp ? 'up' : 'down') : 'administratively down'}, ` +
      `line protocol is ${lineUp ? 'up' : 'down'}`;
    const lines = [stateLine];
    if (svi.ip && svi.mask) {
      const network = svi.ip.networkAddress(svi.mask);
      const bcast = `${network.toString().replace(/\.0$/, '')}.255`;
      lines.push(`  Internet address is ${svi.ip}/${svi.mask.toCIDR()}`);
      lines.push(`  Broadcast address is ${bcast}`);
    } else {
      lines.push('  Internet protocol processing disabled');
    }
    lines.push('  MTU is 1500 bytes');
    lines.push(`  Hardware is EtherSVI, address is ${this.d().getBridgeMac()}`);
    if (svi.helperAddresses.length > 0) {
      for (const h of svi.helperAddresses) {
        lines.push(`  Helper address is ${h}`);
      }
    } else {
      lines.push('  Helper address is not set');
    }
    lines.push('  Directed broadcast forwarding is disabled');
    lines.push('  Outgoing access list is not set');
    lines.push('  Inbound  access list is not set');
    lines.push('  Proxy ARP is enabled');
    lines.push('  Security level is default');
    lines.push('  Split horizon is enabled');
    lines.push('  ICMP redirects are always sent');
    lines.push('  ICMP unreachables are always sent');
    lines.push('  ICMP mask replies are never sent');
    lines.push('  IP fast switching is enabled');
    lines.push('  IP CEF switching is enabled');
    return lines.join('\n');
  }

  /** IOS-style `show ip route` rendering from the Switch's L3 table. */
  private showIpRoute(): string {
    const rows = this.d().getL3RoutingTable();
    const header = [
      'Codes: C - connected, S - static, R - RIP, D - EIGRP, O - OSPF',
      '       B - BGP, * - candidate default',
      '',
      'Gateway of last resort is not set',
      '',
    ];
    const lines: string[] = [];
    // SVI iface naming differs by vendor (Huawei `Vlanif10` vs Cisco
    // `Vlan10`). The routing-table model lives on the shared Switch
    // base, so rewrite to IOS-style here for display purposes only.
    const cisco = (iface: string) => iface.replace(/^Vlanif/, 'Vlan');
    for (const r of rows) {
      const dest = `${r.network}/${r.mask.toCIDR()}`;
      if (r.proto === 'connected') {
        lines.push(`C    ${dest} is directly connected, ${cisco(r.iface)}`);
      } else {
        // Static (or default) route — IOS prefixes a `*` on the
        // candidate default route entry.
        const isDefault = r.network.toString() === '0.0.0.0' && r.mask.toCIDR() === 0;
        const code = isDefault ? 'S*' : 'S';
        const nh = r.nextHop ? r.nextHop.toString() : r.network.toString();
        lines.push(`${code}    ${dest} [1/0] via ${nh}`);
      }
    }
    if (lines.length === 0) lines.push('% No routes installed');
    return [...header, ...lines].join('\n');
  }

  /** IOS `show ip dhcp binding` table — leases currently held by the server. */
  private showIpDhcpBinding(): string {
    const dhcp = this.d()._getDHCPServerInternal();
    const bindings = Array.from(dhcp.getBindings().values());
    const lines: string[] = [
      'Bindings from all pools not associated with VRF:',
      'IP address          Client-ID/              Lease expiration        Type',
      '                    Hardware address/',
      '                    User name',
    ];
    for (const b of bindings) {
      const expire = b.leaseExpiration
        ? new Date(b.leaseExpiration).toUTCString().slice(5, 25)
        : 'Infinite';
      lines.push(`${b.ipAddress.padEnd(20)}01${b.clientId.replace(/:/g, '').toLowerCase().padEnd(22)}${expire.padEnd(24)}Automatic`);
    }
    if (bindings.length === 0) lines.push('% No bindings');
    return lines.join('\n');
  }

  /** IOS `show ip dhcp pool` — render each configured pool's parameters. */
  private showIpDhcpPool(): string {
    const dhcp = this.d()._getDHCPServerInternal();
    const pools = Array.from(dhcp.getAllPools().values());
    if (pools.length === 0) return '% No DHCP pools configured';
    const allBindings = Array.from(dhcp.getBindings().values());
    const blocks: string[] = [];
    for (const pool of pools) {
      const leased = allBindings.filter(
        b => pool.network && pool.mask && this.ipInSubnet(b.ipAddress, pool.network, pool.mask),
      ).length;
      blocks.push([
        `Pool ${pool.name} :`,
        ` Utilization mark (high/low)    : 100 / 0`,
        ` Subnet size (first/next)       : 0 / 0`,
        ` Total addresses                : 254`,
        ` Leased addresses               : ${leased}`,
        ` Pending event                  : none`,
        ` 1 subnet is currently in the pool :`,
        ` Current index        IP address range                    Leased addresses`,
        ` ${(pool.network ?? '?').padEnd(20)} ${(pool.network ?? '?')} - ${pool.network ?? '?'}                ${leased}`,
      ].join('\n'));
    }
    return blocks.join('\n');
  }

  private ipInSubnet(ip: string, network: string, mask: string): boolean {
    try {
      const ipN = new IPAddress(ip);
      const netN = new IPAddress(network);
      const m = new SubnetMask(mask);
      return ipN.isInSameSubnet(netN, m);
    } catch { return false; }
  }

  /** IOS `show arp` — the switch's shared mgmt ARP cache. */
  private showArp(): string {
    const arp = this.d()._getArpTableInternal();
    const lines: string[] = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
    for (const [ip, e] of arp.entries()) {
      const age = e.type === 'static' ? '-' : '0';
      lines.push(`Internet  ${ip.padEnd(17)}${age.padEnd(11)}${e.mac.toString().padEnd(16)}ARPA   ${e.iface}`);
    }
    return lines.join('\n');
  }

  /** `show ip interface brief` — the switch carries IPs only on SVIs. */
  private showIpInterfaceBrief(): string {
    const header = 'Interface              IP-Address      OK? Method Status                Protocol';
    const svis = this.d().getSvis();
    const rows = svis.map(svi => {
      const name = `Vlan${svi.vlan}`;
      const ip = svi.ip ? svi.ip.toString() : 'unassigned';
      const method = svi.ip ? 'manual' : 'unset';
      const status = svi.adminUp ? 'up' : 'administratively down';
      const proto = svi.adminUp && this.d().isSviLineUp(svi) ? 'up' : 'down';
      return `${name.padEnd(23)}${ip.padEnd(16)}YES ${method.padEnd(6)} ${status.padEnd(22)}${proto}`;
    });
    if (rows.length === 0) {
      rows.push(`Vlan1                  unassigned      YES unset  administratively down down`);
    }
    return [header, ...rows].join('\n');
  }

  /** `[no] shutdown` for either a physical port or a management SVI. */
  private setIfAdminState(iface: string, up: boolean): string {
    const vlan = this.sviVlanId(iface);
    if (vlan !== null) { this.d().setSviAdminUp(vlan, up); return ''; }
    const port = this.d().getPort(iface);
    if (port) { port.setUp(up); return ''; }
    return '% Error';
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
