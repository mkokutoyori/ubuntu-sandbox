/**
 * Cisco IOS State Management
 * Manages device configuration and runtime state
 */

import {
  CiscoConfig,
  CiscoInterface,
  CiscoTerminalState,
  CiscoDeviceType,
  CiscoRoute,
  CiscoARPEntry,
  CiscoMACEntry,
  VlanConfig,
  LineConfig,
  DHCPPool,
  AccessList,
  OSPFConfig,
  EIGRPConfig,
  RIPConfig,
  createDefaultInterface,
  generateCiscoMAC,
} from './types';

/**
 * Create default router configuration
 */
export function createDefaultRouterConfig(hostname: string = 'Router'): CiscoConfig {
  const interfaces = new Map<string, CiscoInterface>();

  // Create default interfaces for router
  // GigabitEthernet interfaces
  for (let i = 0; i < 4; i++) {
    const name = `GigabitEthernet0/${i}`;
    interfaces.set(name, createDefaultInterface(name, 'GigabitEthernet', 0, i));
  }

  // Serial interfaces
  for (let i = 0; i < 2; i++) {
    const name = `Serial0/${i}`;
    const iface = createDefaultInterface(name, 'Serial', 0, i);
    iface.bandwidth = 1544;
    iface.delay = 20000;
    interfaces.set(name, iface);
  }

  // Loopback0
  const lo0 = createDefaultInterface('Loopback0', 'Loopback', 0, 0);
  lo0.isUp = true;
  lo0.isAdminDown = false;
  lo0.bandwidth = 8000000;
  lo0.delay = 5000;
  interfaces.set('Loopback0', lo0);

  return {
    deviceType: 'router',
    hostname,
    interfaces,
    vlans: new Map(),
    ipRouting: true,
    staticRoutes: [],
    arpTable: [],
    macTable: [],
    dhcpPools: new Map(),
    dhcpExcluded: [],
    accessLists: new Map(),
    username: [],
    servicePasswordEncryption: false,
    lineConsole: createDefaultLineConfig('console', 0),
    lineVty: [createDefaultLineConfig('vty', 0, 4)],
    banners: {},
    cdpEnabled: true,
    lldpEnabled: false,
    loggingBuffered: true,
    loggingConsole: true,
    loggingLevel: 7,
    ipDomainLookup: true,
    nameServers: [],
  };
}

/**
 * Create default switch configuration
 */
export function createDefaultSwitchConfig(hostname: string = 'Switch'): CiscoConfig {
  const interfaces = new Map<string, CiscoInterface>();

  // Create 24 FastEthernet ports (typical 2960 switch)
  for (let i = 1; i <= 24; i++) {
    const name = `FastEthernet0/${i}`;
    const iface = createDefaultInterface(name, 'FastEthernet', 0, i);
    iface.switchportMode = 'dynamic-auto';
    iface.accessVlan = 1;
    iface.nativeVlan = 1;
    iface.allowedVlans = 'all';
    interfaces.set(name, iface);
  }

  // Create 2 GigabitEthernet uplink ports
  for (let i = 1; i <= 2; i++) {
    const name = `GigabitEthernet0/${i}`;
    const iface = createDefaultInterface(name, 'GigabitEthernet', 0, i);
    iface.switchportMode = 'dynamic-auto';
    iface.accessVlan = 1;
    iface.nativeVlan = 1;
    iface.allowedVlans = 'all';
    interfaces.set(name, iface);
  }

  // Create default VLAN 1
  const vlans = new Map<number, VlanConfig>();
  vlans.set(1, {
    id: 1,
    name: 'default',
    state: 'active',
    shutdown: false,
    mtu: 1500,
    ports: [],
  });

  return {
    deviceType: 'switch',
    hostname,
    interfaces,
    vlans,
    vtpMode: 'server',
    ipRouting: false,
    staticRoutes: [],
    arpTable: [],
    macTable: [],
    dhcpPools: new Map(),
    dhcpExcluded: [],
    accessLists: new Map(),
    username: [],
    servicePasswordEncryption: false,
    lineConsole: createDefaultLineConfig('console', 0),
    lineVty: [createDefaultLineConfig('vty', 0, 15)],
    banners: {},
    stpMode: 'pvst',
    cdpEnabled: true,
    lldpEnabled: false,
    loggingBuffered: true,
    loggingConsole: true,
    loggingLevel: 7,
    ipDomainLookup: true,
    nameServers: [],
  };
}

/**
 * Create default line configuration
 */
function createDefaultLineConfig(
  type: 'console' | 'vty' | 'aux',
  startLine: number,
  endLine?: number
): LineConfig {
  return {
    type,
    startLine,
    endLine,
    login: false,
    loginLocal: false,
    execTimeout: { minutes: 10, seconds: 0 },
    loggingSynchronous: false,
    transportInput: type === 'vty' ? ['telnet'] : undefined,
    transportOutput: type === 'vty' ? ['telnet'] : undefined,
  };
}

/**
 * Create default terminal state
 */
export function createDefaultTerminalState(hostname: string = 'Router'): CiscoTerminalState {
  return {
    hostname,
    mode: 'user',
    isAuthenticated: false,
    terminalLength: 24,
    terminalWidth: 80,
    history: [],
    historyIndex: -1,
    configModified: false,
  };
}

/**
 * Get prompt string based on current mode
 */
export function getPrompt(state: CiscoTerminalState): string {
  const { hostname, mode } = state;

  switch (mode) {
    case 'user':
      return `${hostname}>`;
    case 'privileged':
      return `${hostname}#`;
    case 'global-config':
      return `${hostname}(config)#`;
    case 'interface':
      return `${hostname}(config-if)#`;
    case 'subinterface':
      return `${hostname}(config-subif)#`;
    case 'line':
      return `${hostname}(config-line)#`;
    case 'router':
      if (state.currentRouter) {
        return `${hostname}(config-router)#`;
      }
      return `${hostname}(config)#`;
    case 'vlan':
      return `${hostname}(config-vlan)#`;
    case 'dhcp':
      return `${hostname}(dhcp-config)#`;
    case 'acl':
      return `${hostname}(config-ext-nacl)#`;
    case 'route-map':
      return `${hostname}(config-route-map)#`;
    default:
      return `${hostname}#`;
  }
}

/**
 * Format uptime for show version
 */
export function formatUptime(bootTime: Date): string {
  const now = new Date();
  const diff = now.getTime() - bootTime.getTime();

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);

  return parts.join(', ') || '0 minutes';
}

/**
 * Generate running-config output
 */
export function generateRunningConfig(config: CiscoConfig): string {
  const lines: string[] = [];

  lines.push('Building configuration...');
  lines.push('');
  lines.push('Current configuration : 2048 bytes');
  lines.push('!');
  lines.push(`version 15.1`);
  lines.push(`service timestamps debug datetime msec`);
  lines.push(`service timestamps log datetime msec`);

  if (config.servicePasswordEncryption) {
    lines.push(`service password-encryption`);
  } else {
    lines.push(`no service password-encryption`);
  }

  lines.push(`!`);
  lines.push(`hostname ${config.hostname}`);
  lines.push(`!`);

  // Boot settings
  lines.push(`boot-start-marker`);
  lines.push(`boot-end-marker`);
  lines.push(`!`);

  // Enable secret/password
  if (config.enableSecret) {
    lines.push(`enable secret 5 ${config.enableSecret}`);
  }
  if (config.enablePassword && !config.enableSecret) {
    lines.push(`enable password ${config.enablePassword}`);
  }

  // Users
  for (const user of config.username) {
    lines.push(`username ${user.name} privilege ${user.privilege} secret 5 ${user.secret}`);
  }

  // IP settings
  if (!config.ipDomainLookup) {
    lines.push(`no ip domain lookup`);
  }
  if (config.domainName) {
    lines.push(`ip domain name ${config.domainName}`);
  }

  lines.push(`!`);

  // VTP (switches)
  if (config.deviceType === 'switch' && config.vtpMode) {
    lines.push(`vtp mode ${config.vtpMode}`);
    if (config.vtpDomain) {
      lines.push(`vtp domain ${config.vtpDomain}`);
    }
  }

  // Spanning Tree (switches)
  if (config.deviceType === 'switch' && config.stpMode) {
    lines.push(`spanning-tree mode ${config.stpMode}`);
  }

  lines.push(`!`);

  // VLANs
  if (config.vlans.size > 1) {
    for (const [id, vlan] of config.vlans) {
      if (id === 1) continue; // Skip default VLAN
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      if (vlan.state === 'suspend') {
        lines.push(` state suspend`);
      }
      lines.push(`!`);
    }
  }

  // Interfaces
  for (const [name, iface] of config.interfaces) {
    lines.push(`interface ${name}`);

    if (iface.description) {
      lines.push(` description ${iface.description}`);
    }

    if (config.deviceType === 'switch' && iface.type !== 'Loopback' && iface.type !== 'Vlan') {
      // Switchport configuration
      if (iface.switchportMode === 'access') {
        lines.push(` switchport mode access`);
        if (iface.accessVlan && iface.accessVlan !== 1) {
          lines.push(` switchport access vlan ${iface.accessVlan}`);
        }
      } else if (iface.switchportMode === 'trunk') {
        lines.push(` switchport mode trunk`);
        if (iface.nativeVlan && iface.nativeVlan !== 1) {
          lines.push(` switchport trunk native vlan ${iface.nativeVlan}`);
        }
        if (iface.allowedVlans && iface.allowedVlans !== 'all') {
          lines.push(` switchport trunk allowed vlan ${iface.allowedVlans}`);
        }
      }

      if (iface.voiceVlan) {
        lines.push(` switchport voice vlan ${iface.voiceVlan}`);
      }

      // Port security
      if (iface.portSecurity?.enabled) {
        lines.push(` switchport port-security`);
        lines.push(` switchport port-security maximum ${iface.portSecurity.maximum}`);
        lines.push(` switchport port-security violation ${iface.portSecurity.violation}`);
        if (iface.portSecurity.sticky) {
          lines.push(` switchport port-security mac-address sticky`);
        }
      }

      // Spanning tree
      if (iface.stpPortfast) {
        lines.push(` spanning-tree portfast`);
      }
      if (iface.stpBpduguard) {
        lines.push(` spanning-tree bpduguard enable`);
      }
    } else if (config.deviceType === 'router' || iface.type === 'Vlan') {
      // Layer 3 configuration
      if (iface.ipAddress && iface.subnetMask) {
        lines.push(` ip address ${iface.ipAddress} ${iface.subnetMask}`);
      } else if (iface.type !== 'Loopback') {
        lines.push(` no ip address`);
      }

      // Secondary IPs
      if (iface.secondaryIPs) {
        for (const secondary of iface.secondaryIPs) {
          lines.push(` ip address ${secondary.ip} ${secondary.mask} secondary`);
        }
      }

      // DHCP helper
      if (iface.ipHelper) {
        for (const helper of iface.ipHelper) {
          lines.push(` ip helper-address ${helper}`);
        }
      }

      // OSPF settings
      if (iface.ospfCost) {
        lines.push(` ip ospf cost ${iface.ospfCost}`);
      }
      if (iface.ospfPriority !== undefined) {
        lines.push(` ip ospf priority ${iface.ospfPriority}`);
      }
    }

    // Speed and duplex
    if (iface.speed !== 'auto') {
      lines.push(` speed ${iface.speed}`);
    }
    if (iface.duplex !== 'auto') {
      lines.push(` duplex ${iface.duplex}`);
    }

    // Shutdown state
    if (iface.isAdminDown) {
      lines.push(` shutdown`);
    } else {
      lines.push(` no shutdown`);
    }

    lines.push(`!`);
  }

  // IP routing
  if (config.deviceType === 'router') {
    if (!config.ipRouting) {
      lines.push(`no ip routing`);
    }
  } else {
    if (config.ipRouting) {
      lines.push(`ip routing`);
    }
  }

  // Static routes
  for (const route of config.staticRoutes) {
    if (route.nextHop) {
      lines.push(`ip route ${route.network} ${route.mask} ${route.nextHop}`);
    } else if (route.interface) {
      lines.push(`ip route ${route.network} ${route.mask} ${route.interface}`);
    }
  }

  // Default gateway (switches)
  if (config.defaultGateway) {
    lines.push(`ip default-gateway ${config.defaultGateway}`);
  }

  // OSPF
  if (config.ospf) {
    lines.push(`!`);
    lines.push(`router ospf ${config.ospf.processId}`);
    if (config.ospf.routerId) {
      lines.push(` router-id ${config.ospf.routerId}`);
    }
    for (const network of config.ospf.networks) {
      lines.push(` network ${network.network} ${network.wildcardMask} area ${network.area}`);
    }
    for (const passive of config.ospf.passiveInterfaces) {
      lines.push(` passive-interface ${passive}`);
    }
    if (config.ospf.defaultInformationOriginate) {
      lines.push(` default-information originate`);
    }
  }

  // EIGRP
  if (config.eigrp) {
    lines.push(`!`);
    lines.push(`router eigrp ${config.eigrp.asNumber}`);
    for (const network of config.eigrp.networks) {
      lines.push(` network ${network}`);
    }
    if (!config.eigrp.autoSummary) {
      lines.push(` no auto-summary`);
    }
  }

  // RIP
  if (config.rip) {
    lines.push(`!`);
    lines.push(`router rip`);
    if (config.rip.version === 2) {
      lines.push(` version 2`);
    }
    for (const network of config.rip.networks) {
      lines.push(` network ${network}`);
    }
    if (!config.rip.autoSummary) {
      lines.push(` no auto-summary`);
    }
  }

  // Access lists
  for (const [id, acl] of config.accessLists) {
    lines.push(`!`);
    if (typeof id === 'number') {
      for (const entry of acl.entries) {
        if (acl.type === 'standard') {
          lines.push(`access-list ${id} ${entry.action} ${entry.sourceIP} ${entry.sourceWildcard}`);
        } else {
          let line = `access-list ${id} ${entry.action} ${entry.protocol}`;
          line += ` ${entry.sourceIP} ${entry.sourceWildcard}`;
          line += ` ${entry.destIP} ${entry.destWildcard}`;
          if (entry.destPort) {
            line += ` ${entry.destPort.operator} ${entry.destPort.ports.join(' ')}`;
          }
          lines.push(line);
        }
      }
    } else {
      lines.push(`ip access-list ${acl.type} ${id}`);
      for (const entry of acl.entries) {
        let line = ` ${entry.sequence} ${entry.action} ${entry.protocol}`;
        line += ` ${entry.sourceIP} ${entry.sourceWildcard}`;
        line += ` ${entry.destIP} ${entry.destWildcard}`;
        lines.push(line);
      }
    }
  }

  // Banners
  if (config.banners.motd) {
    lines.push(`!`);
    lines.push(`banner motd ^C${config.banners.motd}^C`);
  }
  if (config.banners.login) {
    lines.push(`banner login ^C${config.banners.login}^C`);
  }

  // Line configurations
  lines.push(`!`);
  lines.push(`line con 0`);
  if (config.lineConsole.password) {
    lines.push(` password ${config.lineConsole.password}`);
  }
  if (config.lineConsole.login) {
    lines.push(` login`);
  }
  if (config.lineConsole.loggingSynchronous) {
    lines.push(` logging synchronous`);
  }

  for (const vty of config.lineVty) {
    lines.push(`!`);
    lines.push(`line vty ${vty.startLine} ${vty.endLine || vty.startLine}`);
    if (vty.password) {
      lines.push(` password ${vty.password}`);
    }
    if (vty.loginLocal) {
      lines.push(` login local`);
    } else if (vty.login) {
      lines.push(` login`);
    }
    if (vty.transportInput) {
      lines.push(` transport input ${vty.transportInput.join(' ')}`);
    }
  }

  lines.push(`!`);
  lines.push(`end`);

  return lines.join('\n');
}

/**
 * Generate startup-config (same format, just labeled differently)
 */
export function generateStartupConfig(config: CiscoConfig): string {
  return generateRunningConfig(config).replace(
    'Current configuration',
    'Startup configuration'
  );
}

/**
 * Compare running and startup config
 */
export function configsAreEqual(running: string, startup: string): boolean {
  // Simple comparison - in real implementation would be more sophisticated
  const normalizeConfig = (config: string) =>
    config
      .split('\n')
      .filter(line => !line.startsWith('Building') && !line.includes('bytes'))
      .join('\n');

  return normalizeConfig(running) === normalizeConfig(startup);
}
