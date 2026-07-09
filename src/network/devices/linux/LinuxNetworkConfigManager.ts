import type { VirtualFileSystem } from './VirtualFileSystem';
import type { LinuxLogManager } from './LinuxLogManager';
import type { LinuxNetKernel } from './LinuxNetKernel';
import { IPAddress, SubnetMask } from '../../core/types';
import {
  parseInterfacesFile,
  serializeInterfacesFile,
  parseNetplanYaml,
  serializeNetplanYaml,
  type DeclaredInterfaceConfig,
  type NetplanConfig,
} from './net/NetworkConfigFiles';

export const INTERFACES_PATH = '/etc/network/interfaces';
export const NETPLAN_PATH = '/etc/netplan/01-netcfg.yaml';
export const NM_CONF_PATH = '/etc/NetworkManager/NetworkManager.conf';

export interface DriftEntry {
  iface: string;
  field: 'address' | 'mtu' | 'gateway';
  declared: string;
  runtime: string;
}

export class LinuxNetworkConfigManager {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly logMgr: LinuxLogManager,
  ) {}

  seedDefaults(ifaceNames: readonly string[]): void {
    if (!this.vfs.exists(INTERFACES_PATH)) {
      const configs = new Map<string, DeclaredInterfaceConfig>();
      for (const name of ifaceNames) configs.set(name, { method: 'dhcp' });
      this.vfs.createFileAt(INTERFACES_PATH, serializeInterfacesFile(configs), 0o644, 0, 0);
    }
    if (!this.vfs.exists(NETPLAN_PATH)) {
      const interfaces = new Map<string, DeclaredInterfaceConfig>();
      for (const name of ifaceNames) interfaces.set(name, { method: 'dhcp' });
      const cfg: NetplanConfig = { renderer: 'networkd', interfaces };
      if (!this.vfs.exists('/etc/netplan')) this.vfs.mkdirp('/etc/netplan', 0o755, 0, 0);
      this.vfs.createFileAt(NETPLAN_PATH, serializeNetplanYaml(cfg), 0o600, 0, 0);
    }
    if (!this.vfs.exists(NM_CONF_PATH)) {
      if (!this.vfs.exists('/etc/NetworkManager')) this.vfs.mkdirp('/etc/NetworkManager', 0o755, 0, 0);
      this.vfs.createFileAt(
        NM_CONF_PATH,
        '[main]\nplugins=ifupdown,keyfile\n\n[ifupdown]\nmanaged=false\n',
        0o644, 0, 0,
      );
    }
  }

  readNetplan(): NetplanConfig | null {
    const text = this.vfs.readFile(NETPLAN_PATH);
    if (text === null) return null;
    return parseNetplanYaml(text);
  }

  readInterfacesFile(): Map<string, DeclaredInterfaceConfig> | null {
    const text = this.vfs.readFile(INTERFACES_PATH);
    if (text === null) return null;
    return parseInterfacesFile(text);
  }

  private applyDeclaredConfig(net: LinuxNetKernel, name: string, cfg: DeclaredInterfaceConfig): string[] {
    const applied: string[] = [];
    const port = net.getPorts().get(name);
    if (!port) return applied;
    if (cfg.method === 'static' && cfg.address) {
      const mask = SubnetMask.fromCIDR(cfg.cidr ?? 24);
      net.configureInterface(name, new IPAddress(cfg.address), mask);
      applied.push(`${name}: IPv4 address ${cfg.address}/${cfg.cidr ?? 24} applied from configuration file`);
      if (cfg.gateway) {
        net.setDefaultGateway(new IPAddress(cfg.gateway));
        applied.push(`${name}: default gateway ${cfg.gateway} applied from configuration file`);
      }
    }
    if (cfg.mtu !== undefined && port.getMTU() !== cfg.mtu) {
      port.setMTU(cfg.mtu);
      applied.push(`${name}: MTU set to ${cfg.mtu} from configuration file`);
    }
    return applied;
  }

  applyNetplan(net: LinuxNetKernel): { applied: string[]; warnings: string[] } {
    const cfg = this.readNetplan();
    const applied: string[] = [];
    if (cfg) {
      for (const [name, iface] of cfg.interfaces) {
        applied.push(...this.applyDeclaredConfig(net, name, iface));
      }
    }
    for (const line of applied) this.logMgr.logSystemd('systemd-networkd', line);
    const warnings = this.detectManagementConflicts(cfg);
    for (const w of warnings) this.logMgr.logDaemon('netplan', w);
    return { applied, warnings };
  }

  tryNetplan(net: LinuxNetKernel): string {
    const cfg = this.readNetplan();
    if (!cfg) return 'Cannot find any netplan configuration.';
    const drift = this.computeDrift(net, cfg.interfaces);
    if (drift.length === 0) {
      return 'No configuration changes to apply.';
    }
    const lines = [
      'Warning: cannot apply new config: press ENTER before the timeout to accept the new configuration',
      '',
      ...drift.map(d => `  ${d.iface}: ${d.field} ${d.runtime || '(none)'} -> ${d.declared}`),
      '',
      'Configuration was not applied (dry-run).',
    ];
    return lines.join('\n');
  }

  ifup(net: LinuxNetKernel, ifaceName?: string): string {
    const configs = this.readInterfacesFile();
    if (!configs) return 'ifup: could not read /etc/network/interfaces';
    const targets = ifaceName ? [ifaceName] : [...configs.keys()];
    const lines: string[] = [];
    for (const name of targets) {
      const cfg = configs.get(name);
      if (!cfg) { lines.push(`ifup: unknown interface ${name}`); continue; }
      net.setInterfaceAdmin(name, true);
      const applied = this.applyDeclaredConfig(net, name, cfg);
      for (const line of applied) this.logMgr.logDaemon('ifup', line);
      lines.push(...applied);
    }
    return lines.length ? lines.join('\n') : '';
  }

  ifdown(net: LinuxNetKernel, ifaceName: string): string {
    const port = net.getPorts().get(ifaceName);
    if (!port) return `ifdown: unknown interface ${ifaceName}`;
    net.clearInterfaceIP(ifaceName);
    net.setInterfaceAdmin(ifaceName, false);
    this.logMgr.logDaemon('ifdown', `${ifaceName}: interface brought down and IPv4 config cleared`);
    return '';
  }

  computeDrift(net: LinuxNetKernel, declared: ReadonlyMap<string, DeclaredInterfaceConfig>): DriftEntry[] {
    const drift: DriftEntry[] = [];
    for (const [name, cfg] of declared) {
      const port = net.getPorts().get(name);
      if (!port) continue;
      if (cfg.method === 'static' && cfg.address) {
        const runtimeIp = port.getIPAddress()?.toString() ?? '';
        const runtimeCidr = port.getSubnetMask()?.toCIDR();
        const declaredAddr = `${cfg.address}/${cfg.cidr ?? 24}`;
        const runtimeAddr = runtimeIp ? `${runtimeIp}/${runtimeCidr}` : '';
        if (runtimeAddr !== declaredAddr) {
          drift.push({ iface: name, field: 'address', declared: declaredAddr, runtime: runtimeAddr });
        }
      }
      if (cfg.mtu !== undefined && port.getMTU() !== cfg.mtu) {
        drift.push({ iface: name, field: 'mtu', declared: String(cfg.mtu), runtime: String(port.getMTU()) });
      }
    }
    return drift;
  }

  isManagedByNetworkManager(_iface: string): boolean {
    const cfg = this.readNetplan();
    if (cfg?.renderer === 'NetworkManager') return true;
    const nmConf = this.vfs.readFile(NM_CONF_PATH) ?? '';
    const explicitlyUnmanaged = /\[ifupdown\][^[]*managed\s*=\s*false/is.test(nmConf);
    return !explicitlyUnmanaged;
  }

  private detectManagementConflicts(cfg: NetplanConfig | null): string[] {
    if (!cfg || cfg.renderer !== 'networkd') return [];
    const warnings: string[] = [];
    for (const [name] of cfg.interfaces) {
      if (this.isManagedByNetworkManager(name)) {
        warnings.push(`netplan apply: WARNING: ${name} is configured by networkd but is also managed by NetworkManager`);
      }
    }
    return warnings;
  }

  networkctlStatus(net: LinuxNetKernel, ifaceName?: string): string {
    const cfg = this.readNetplan();
    const names = ifaceName ? [ifaceName] : [...net.getPorts().keys()];
    const blocks: string[] = [];
    for (const name of names) {
      const port = net.getPorts().get(name);
      if (!port) { blocks.push(`Unknown interface ${name}`); continue; }
      const declared = cfg?.interfaces.get(name);
      const state = port.getIsUp() && port.isConnected() ? 'routable (configured)' : 'off';
      const source = declared?.method === 'static' ? 'static' : 'DHCPv4';
      const managed = this.isManagedByNetworkManager(name);
      const lines = [
        `● ${name}`,
        `       Link File: /usr/lib/systemd/network/99-default.link`,
        `    Network File: ${this.vfs.exists(NETPLAN_PATH) ? NETPLAN_PATH : 'n/a'} (${cfg?.renderer ?? 'networkd'})`,
        `            Type: ether`,
        `           State: ${state}`,
        `  Address Source: ${source}`,
      ];
      if (cfg?.renderer === 'networkd' && managed) {
        lines.push('         Warning: also managed by NetworkManager (conflicting configuration)');
      }
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
  }

  nmcliDeviceStatus(net: LinuxNetKernel): string {
    const header = 'DEVICE  TYPE      STATE                   CONNECTION';
    const rows: string[] = [];
    for (const [name, port] of net.getPorts()) {
      const managed = this.isManagedByNetworkManager(name);
      let state: string;
      let connection: string;
      if (!managed) {
        state = 'unmanaged';
        connection = '--';
      } else if (port.getIsUp() && port.isConnected()) {
        state = 'connected';
        connection = name;
      } else {
        state = 'disconnected';
        connection = '--';
      }
      rows.push(`${name.padEnd(8)}ethernet  ${state.padEnd(24)}${connection}`);
    }
    return [header, ...rows].join('\n');
  }

  nmcliDeviceShow(net: LinuxNetKernel, ifaceName: string): string {
    const port = net.getPorts().get(ifaceName);
    if (!port) return `Error: Device '${ifaceName}' not found.`;
    const managed = this.isManagedByNetworkManager(ifaceName);
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const lines = [
      `GENERAL.DEVICE:                        ${ifaceName}`,
      `GENERAL.TYPE:                          ethernet`,
      `GENERAL.HWADDR:                        ${port.getMAC().toString()}`,
      `GENERAL.MTU:                           ${port.getMTU()}`,
      `GENERAL.STATE:                         ${!managed ? 'unmanaged' : (port.getIsUp() && port.isConnected() ? '100 (connected)' : '20 (unavailable)')}`,
      `GENERAL.CONNECTION:                    ${managed && ip ? ifaceName : '--'}`,
    ];
    if (ip && mask) {
      lines.push(`IP4.ADDRESS[1]:                        ${ip.toString()}/${mask.toCIDR()}`);
    }
    return lines.join('\n');
  }
}
