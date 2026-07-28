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
import {
  discoverNetworkdFiles,
  matchLinkFile,
  matchNetworkFile,
  DEFAULT_LINK_FILE_PATH,
  DEFAULT_LINK_FILE_TEXT,
} from './net/NetworkdFiles';

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
    // Le répertoire d'administration existe même vide sur un Ubuntu neuf,
    // et le .link par défaut est fourni par le paquet systemd — sans lui,
    // `networkctl status` nommait un fichier qui n'existait pas.
    if (!this.vfs.exists('/etc/systemd/network')) {
      this.vfs.mkdirp('/etc/systemd/network', 0o755, 0, 0);
    }
    if (!this.vfs.exists(DEFAULT_LINK_FILE_PATH)) {
      this.vfs.mkdirp('/usr/lib/systemd/network', 0o755, 0, 0);
      this.vfs.createFileAt(DEFAULT_LINK_FILE_PATH, DEFAULT_LINK_FILE_TEXT, 0o644, 0, 0);
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

  ifup(net: LinuxNetKernel, ifaceName?: string, noAct = false): string {
    const configs = this.readInterfacesFile();
    if (!configs) return 'ifup: could not read /etc/network/interfaces';
    const targets = ifaceName ? [ifaceName] : [...configs.keys()];
    const lines: string[] = [];
    for (const name of targets) {
      const cfg = configs.get(name);
      if (!cfg) { lines.push(`ifup: unknown interface ${name}`); continue; }
      if (noAct) {
        lines.push(...this.describeDeclaredConfig(name, cfg));
        continue;
      }
      net.setInterfaceAdmin(name, true);
      const applied = this.applyDeclaredConfig(net, name, cfg);
      for (const line of applied) this.logMgr.logDaemon('ifup', line);
      lines.push(...applied);
    }
    return lines.length ? lines.join('\n') : '';
  }

  /** Dry-run (`--no-act`) equivalent of applyDeclaredConfig: validates and
   * describes what would happen, without touching interface state. */
  private describeDeclaredConfig(name: string, cfg: DeclaredInterfaceConfig): string[] {
    const described: string[] = [];
    if (cfg.method === 'static' && cfg.address) {
      described.push(`ifup: (dry-run) would set ${name} IPv4 address ${cfg.address}/${cfg.cidr ?? 24}`);
      if (cfg.gateway) described.push(`ifup: (dry-run) would set ${name} default gateway ${cfg.gateway}`);
    } else if (cfg.method === 'dhcp') {
      described.push(`ifup: (dry-run) would run dhclient on ${name}`);
    }
    if (cfg.mtu !== undefined) described.push(`ifup: (dry-run) would set ${name} MTU to ${cfg.mtu}`);
    if (described.length === 0) described.push(`ifup: (dry-run) ${name}: nothing to apply`);
    return described;
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

  /** Fichiers networkd qui s'appliquent réellement à `iface` (§5 du PRD). */
  resolveNetworkdFiles(iface: string): { networkFile: string | null; linkFile: string | null } {
    const files = discoverNetworkdFiles(this.vfs);
    const network = matchNetworkFile(files, iface);
    const link = matchLinkFile(files, iface);
    return {
      // Netplan reste prioritaire quand il existe : c'est ce que fait
      // Ubuntu, et netplan génère justement ces fichiers-là.
      networkFile: network?.path ?? (this.vfs.exists(NETPLAN_PATH) ? NETPLAN_PATH : null),
      linkFile: link?.path ?? null,
    };
  }

  /** `networkctl cat` / `networkctl edit`. */
  networkdFileAction(
    net: LinuxNetKernel,
    verb: 'cat' | 'edit',
    targets: readonly string[],
  ): { output: string; exitCode: number } {
    const files = discoverNetworkdFiles(this.vfs);
    const paths: string[] = [];
    if (targets.length === 0) {
      paths.push(...files.map((f) => f.path));
      if (this.vfs.exists(NETPLAN_PATH)) paths.push(NETPLAN_PATH);
    }
    for (const target of targets) {
      if (net.getPorts().has(target)) {
        const resolved = this.resolveNetworkdFiles(target);
        for (const p of [resolved.networkFile, resolved.linkFile]) if (p) paths.push(p);
        continue;
      }
      const byName = files.find((f) => f.basename === target || f.path === target);
      if (byName) { paths.push(byName.path); continue; }
      if (this.vfs.exists(target)) { paths.push(target); continue; }
      return { output: `Cannot find device or file '${target}'.`, exitCode: 1 };
    }

    const unique = [...new Set(paths)];
    if (unique.length === 0) {
      return { output: 'No network configuration files found.', exitCode: 1 };
    }
    if (verb === 'edit') {
      // L'édition passe par l'éditeur déjà simulé ; ici on se borne à
      // désigner le fichier, sans prétendre l'avoir ouvert.
      return { output: unique.map((p) => `Would edit ${p}`).join('\n'), exitCode: 0 };
    }
    const blocks = unique.map((p) => `# ${p}\n${this.vfs.readFile(p) ?? ''}`.trimEnd());
    return { output: blocks.join('\n\n'), exitCode: 0 };
  }

  /** `networkctl reconfigure <iface>` — réapplique le seul lien visé. */
  reconfigureInterface(net: LinuxNetKernel, iface: string): string[] {
    const declared = this.readNetplan()?.interfaces.get(iface);
    if (!declared) return [];
    const applied = this.applyDeclaredConfig(net, iface, declared);
    for (const line of applied) this.logMgr.logSystemd('systemd-networkd', line);
    return applied;
  }

  /**
   * Table des étiquettes d'adresses de la RFC 3484, telle que systemd la
   * porte en dur : c'est une constante du protocole, pas un état.
   */
  addressLabelTable(): string {
    const rows: Array<[string, number]> = [
      ['::1/128', 0], ['::/0', 1], ['2002::/16', 2], ['::/96', 3],
      ['::ffff:0.0.0.0/96', 4], ['2001::/32', 5], ['fc00::/7', 13],
      ['::ffff:0.0.0.0/96', 4],
    ];
    const seen = new Set<string>();
    const lines = ['LABEL PREFIX/PREFIXLEN'];
    for (const [prefix, label] of rows) {
      const key = `${prefix}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`${String(label).padStart(5)} ${prefix}`);
    }
    return lines.join('\n');
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
