/**
 * Cisco IOS Configuration Commands
 * Implements global and interface configuration commands
 */

import {
  CiscoConfig,
  CiscoTerminalState,
  CiscoCommandResult,
  CiscoInterface,
  CiscoMode,
  VlanConfig,
  LineConfig,
  DHCPPool,
  AccessList,
  ACLEntry,
  OSPFConfig,
  EIGRPConfig,
  RIPConfig,
  expandInterfaceName,
  parseInterfaceName,
  createDefaultInterface,
  subnetToWildcard,
  prefixToSubnetMask,
} from '../types';

/**
 * Execute configuration command based on current mode
 */
export function executeConfigCommand(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig
): CiscoCommandResult {
  const fullCommand = [command, ...args].join(' ');

  // Handle 'no' prefix for negation
  const isNegation = command === 'no';
  const actualCommand = isNegation ? args[0] : command;
  const actualArgs = isNegation ? args.slice(1) : args;

  switch (state.mode) {
    case 'global-config':
      return executeGlobalConfig(actualCommand, actualArgs, state, config, isNegation);

    case 'interface':
    case 'subinterface':
      return executeInterfaceConfig(actualCommand, actualArgs, state, config, isNegation);

    case 'line':
      return executeLineConfig(actualCommand, actualArgs, state, config, isNegation);

    case 'router':
      return executeRouterConfig(actualCommand, actualArgs, state, config, isNegation);

    case 'vlan':
      return executeVlanConfig(actualCommand, actualArgs, state, config, isNegation);

    case 'dhcp':
      return executeDHCPConfig(actualCommand, actualArgs, state, config, isNegation);

    case 'acl':
      return executeACLConfig(actualCommand, actualArgs, state, config, isNegation);

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * Global configuration mode commands
 */
function executeGlobalConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  switch (command) {
    case 'hostname':
      return configHostname(args, state, config, isNegation);

    case 'enable':
      return configEnable(args, config, isNegation);

    case 'username':
      return configUsername(args, config, isNegation);

    case 'service':
      return configService(args, config, isNegation);

    case 'ip':
      return configIP(args, state, config, isNegation);

    case 'interface':
    case 'int':
      return configInterface(args, state, config);

    case 'line':
      return configLine(args, state);

    case 'router':
      return configRouter(args, state, config, isNegation);

    case 'vlan':
      return configVlan(args, state, config, isNegation);

    case 'banner':
      return configBanner(args, config, isNegation);

    case 'logging':
      return configLogging(args, config, isNegation);

    case 'cdp':
      return configCDP(args, config, isNegation);

    case 'lldp':
      return configLLDP(args, config, isNegation);

    case 'spanning-tree':
      return configSpanningTree(args, config, isNegation);

    case 'vtp':
      return configVTP(args, config, isNegation);

    case 'access-list':
      return configAccessList(args, config, isNegation);

    case 'ntp':
      return configNTP(args, config, isNegation);

    case 'clock':
      return configClock(args, config);

    case 'snmp-server':
      return configSNMP(args, config, isNegation);

    case 'end':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    case 'exit':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    case 'do':
      // Allow privileged EXEC commands from config mode
      return {
        output: '',
        error: 'Use do command followed by privileged EXEC command',
        exitCode: 1,
      };

    default:
      return { output: '', error: `% Invalid input detected at '^' marker.`, exitCode: 1 };
  }
}

/**
 * Configure hostname
 */
function configHostname(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (isNegation) {
    config.hostname = config.deviceType === 'router' ? 'Router' : 'Switch';
    state.hostname = config.hostname;
    return { output: '', exitCode: 0 };
  }

  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const newHostname = args[0];
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(newHostname) || newHostname.length > 63) {
    return { output: '', error: '% Invalid hostname', exitCode: 1 };
  }

  config.hostname = newHostname;
  state.hostname = newHostname;
  state.configModified = true;

  return { output: '', exitCode: 0 };
}

/**
 * Configure enable password/secret
 */
function configEnable(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (isNegation) {
    if (args[0] === 'secret') {
      config.enableSecret = undefined;
    } else if (args[0] === 'password') {
      config.enablePassword = undefined;
    }
    return { output: '', exitCode: 0 };
  }

  if (args.length < 2) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  if (args[0] === 'secret') {
    config.enableSecret = args[1];
  } else if (args[0] === 'password') {
    config.enablePassword = args[1];
  } else {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure username
 */
function configUsername(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const username = args[0];

  if (isNegation) {
    config.username = config.username.filter(u => u.name !== username);
    return { output: '', exitCode: 0 };
  }

  let privilege = 15;
  let secret = '';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'privilege' && args[i + 1]) {
      privilege = parseInt(args[++i]) || 15;
    } else if (args[i] === 'secret' && args[i + 1]) {
      secret = args[++i];
    } else if (args[i] === 'password' && args[i + 1]) {
      secret = args[++i];
    }
  }

  if (!secret) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  // Update or add user
  const existingIndex = config.username.findIndex(u => u.name === username);
  if (existingIndex >= 0) {
    config.username[existingIndex] = { name: username, privilege, secret };
  } else {
    config.username.push({ name: username, privilege, secret });
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure service settings
 */
function configService(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const service = args.join('-');

  if (service === 'password-encryption') {
    config.servicePasswordEncryption = !isNegation;
    return { output: '', exitCode: 0 };
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure IP settings (global)
 */
function configIP(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0];
  const subArgs = args.slice(1);

  switch (subCommand) {
    case 'routing':
      config.ipRouting = !isNegation;
      return { output: '', exitCode: 0 };

    case 'route':
      return configStaticRoute(subArgs, config, isNegation);

    case 'default-gateway':
      if (isNegation) {
        config.defaultGateway = undefined;
      } else if (subArgs[0]) {
        config.defaultGateway = subArgs[0];
      }
      return { output: '', exitCode: 0 };

    case 'domain-name':
    case 'domain':
      if (isNegation) {
        config.domainName = undefined;
      } else if (subArgs[0]) {
        config.domainName = subArgs[0];
      }
      return { output: '', exitCode: 0 };

    case 'domain-lookup':
      config.ipDomainLookup = !isNegation;
      return { output: '', exitCode: 0 };

    case 'name-server':
      if (isNegation) {
        config.nameServers = config.nameServers.filter(ns => ns !== subArgs[0]);
      } else if (subArgs[0]) {
        if (!config.nameServers.includes(subArgs[0])) {
          config.nameServers.push(subArgs[0]);
        }
      }
      return { output: '', exitCode: 0 };

    case 'dhcp':
      if (subArgs[0] === 'pool') {
        return configDHCPPool(subArgs.slice(1), state, config, isNegation);
      }
      if (subArgs[0] === 'excluded-address') {
        return configDHCPExcluded(subArgs.slice(1), config, isNegation);
      }
      return { output: '', error: '% Invalid input detected', exitCode: 1 };

    case 'access-list':
      return configNamedAccessList(subArgs, state, config, isNegation);

    case 'nat':
      return configNAT(subArgs, config, isNegation);

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * Configure static route
 */
function configStaticRoute(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length < 2) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const network = args[0];
  const mask = args[1];
  const nextHopOrInterface = args[2];
  const metric = args[3] ? parseInt(args[3]) : undefined;

  if (isNegation) {
    config.staticRoutes = config.staticRoutes.filter(
      r => !(r.network === network && r.mask === mask)
    );
    return { output: '', exitCode: 0 };
  }

  if (!nextHopOrInterface) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  // Check if it's an IP address or interface name
  const isIPAddress = /^\d+\.\d+\.\d+\.\d+$/.test(nextHopOrInterface);

  const route = {
    protocol: 'S' as const,
    network,
    mask,
    nextHop: isIPAddress ? nextHopOrInterface : undefined,
    interface: !isIPAddress ? nextHopOrInterface : undefined,
    metric,
    administrativeDistance: 1,
  };

  // Check if route already exists
  const existingIndex = config.staticRoutes.findIndex(
    r => r.network === network && r.mask === mask
  );

  if (existingIndex >= 0) {
    config.staticRoutes[existingIndex] = route;
  } else {
    config.staticRoutes.push(route);
  }

  return { output: '', exitCode: 0 };
}

/**
 * Enter interface configuration mode
 */
function configInterface(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const ifaceName = expandInterfaceName(args.join(''));

  // Check if interface exists
  let iface = config.interfaces.get(ifaceName);

  // If it's a loopback or VLAN interface, create it if it doesn't exist
  if (!iface) {
    const parsed = parseInterfaceName(ifaceName);
    if (parsed) {
      if (parsed.type === 'Loopback') {
        iface = createDefaultInterface(ifaceName, 'Loopback', 0, parsed.port);
        iface.bandwidth = 8000000;
        iface.delay = 5000;
        config.interfaces.set(ifaceName, iface);
      } else if (parsed.type === 'Vlan') {
        iface = createDefaultInterface(ifaceName, 'Vlan', 0, parsed.port);
        config.interfaces.set(ifaceName, iface);
      } else if (parsed.subinterface !== undefined) {
        // Subinterface - create it
        const parentName = `${parsed.type}${parsed.slot}/${parsed.port}`;
        if (config.interfaces.has(parentName)) {
          iface = createDefaultInterface(ifaceName, parsed.type as any, parsed.slot, parsed.port);
          iface.subinterface = parsed.subinterface;
          config.interfaces.set(ifaceName, iface);
        }
      }
    }
  }

  if (!iface) {
    return { output: '', error: '% Invalid interface type and target', exitCode: 1 };
  }

  const isSubinterface = ifaceName.includes('.');

  return {
    output: '',
    exitCode: 0,
    newMode: isSubinterface ? 'subinterface' : 'interface',
    newInterface: ifaceName,
  };
}

/**
 * Enter line configuration mode
 */
function configLine(args: string[], state: CiscoTerminalState): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const lineType = args[0].toLowerCase() as 'console' | 'vty' | 'aux';
  const startLine = parseInt(args[1]) || 0;
  const endLine = args[2] ? parseInt(args[2]) : undefined;

  if (!['console', 'vty', 'aux', 'con'].includes(lineType)) {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  return {
    output: '',
    exitCode: 0,
    newMode: 'line',
    newLine: {
      type: lineType === 'con' ? 'console' : lineType,
      start: startLine,
      end: endLine,
    },
  };
}

/**
 * Enter router configuration mode
 */
function configRouter(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const protocol = args[0].toLowerCase() as 'ospf' | 'eigrp' | 'rip' | 'bgp';
  const processId = parseInt(args[1]) || 1;

  if (!['ospf', 'eigrp', 'rip', 'bgp'].includes(protocol)) {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  if (isNegation) {
    // Remove routing protocol configuration
    if (protocol === 'ospf') {
      config.ospf = undefined;
    } else if (protocol === 'eigrp') {
      config.eigrp = undefined;
    } else if (protocol === 'rip') {
      config.rip = undefined;
    }
    return { output: '', exitCode: 0 };
  }

  // Initialize routing protocol if not exists
  if (protocol === 'ospf' && !config.ospf) {
    config.ospf = {
      processId,
      networks: [],
      passiveInterfaces: [],
      defaultInformationOriginate: false,
      redistributeStatic: false,
      redistributeConnected: false,
    };
  } else if (protocol === 'eigrp' && !config.eigrp) {
    config.eigrp = {
      asNumber: processId,
      networks: [],
      passiveInterfaces: [],
      autoSummary: true,
    };
  } else if (protocol === 'rip' && !config.rip) {
    config.rip = {
      version: 2,
      networks: [],
      passiveInterfaces: [],
      autoSummary: true,
      defaultInformationOriginate: false,
    };
  }

  return {
    output: '',
    exitCode: 0,
    newMode: 'router',
    newRouter: { protocol, id: processId },
  };
}

/**
 * Enter VLAN configuration mode
 */
function configVlan(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const vlanId = parseInt(args[0]);

  if (isNaN(vlanId) || vlanId < 1 || vlanId > 4094) {
    return { output: '', error: '% Bad VLAN list - character #1 is a non-numeric character', exitCode: 1 };
  }

  if (isNegation) {
    if (vlanId === 1) {
      return { output: '', error: '% Default VLAN 1 may not be deleted.', exitCode: 1 };
    }
    config.vlans.delete(vlanId);
    return { output: '', exitCode: 0 };
  }

  // Create VLAN if it doesn't exist
  if (!config.vlans.has(vlanId)) {
    config.vlans.set(vlanId, {
      id: vlanId,
      name: `VLAN${String(vlanId).padStart(4, '0')}`,
      state: 'active',
      shutdown: false,
      mtu: 1500,
      ports: [],
    });
  }

  return {
    output: '',
    exitCode: 0,
    newMode: 'vlan',
    newVlan: vlanId,
  };
}

/**
 * Configure banner
 */
function configBanner(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const bannerType = args[0].toLowerCase() as 'motd' | 'login' | 'exec';

  if (isNegation) {
    if (bannerType === 'motd') {
      config.banners.motd = undefined;
    } else if (bannerType === 'login') {
      config.banners.login = undefined;
    } else if (bannerType === 'exec') {
      config.banners.exec = undefined;
    }
    return { output: '', exitCode: 0 };
  }

  // Get banner text (everything after delimiter)
  const bannerText = args.slice(2).join(' ');

  if (bannerType === 'motd') {
    config.banners.motd = bannerText;
  } else if (bannerType === 'login') {
    config.banners.login = bannerText;
  } else if (bannerType === 'exec') {
    config.banners.exec = bannerText;
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure logging
 */
function configLogging(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0].toLowerCase();

  switch (subCommand) {
    case 'buffered':
      config.loggingBuffered = !isNegation;
      break;
    case 'console':
      config.loggingConsole = !isNegation;
      break;
    case 'synchronous':
      // Handled in line config
      break;
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure CDP
 */
function configCDP(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0 || args[0] === 'run') {
    config.cdpEnabled = !isNegation;
    return { output: '', exitCode: 0 };
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure LLDP
 */
function configLLDP(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0 || args[0] === 'run') {
    config.lldpEnabled = !isNegation;
    return { output: '', exitCode: 0 };
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure Spanning Tree
 */
function configSpanningTree(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0].toLowerCase();

  if (subCommand === 'mode') {
    if (isNegation) {
      config.stpMode = 'pvst';
    } else {
      const mode = args[1]?.toLowerCase() as 'pvst' | 'rapid-pvst' | 'mst';
      if (['pvst', 'rapid-pvst', 'mst'].includes(mode)) {
        config.stpMode = mode;
      }
    }
  } else if (subCommand === 'vlan') {
    // Handle per-VLAN STP settings
    const vlanId = parseInt(args[1]);
    const setting = args[2]?.toLowerCase();

    if (setting === 'priority') {
      const priority = parseInt(args[3]);
      if (!config.stpPriority) config.stpPriority = [];
      const existing = config.stpPriority.findIndex(p => p.vlan === vlanId);
      if (existing >= 0) {
        config.stpPriority[existing].priority = priority;
      } else {
        config.stpPriority.push({ vlan: vlanId, priority });
      }
    }
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure VTP
 */
function configVTP(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0].toLowerCase();

  if (subCommand === 'mode') {
    const mode = args[1]?.toLowerCase() as 'server' | 'client' | 'transparent' | 'off';
    if (['server', 'client', 'transparent', 'off'].includes(mode)) {
      config.vtpMode = mode;
    }
  } else if (subCommand === 'domain') {
    config.vtpDomain = args[1];
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure numbered access list
 */
function configAccessList(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length < 1) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const aclNumber = parseInt(args[0]);

  // Handle negation (no access-list X) - removes entire ACL
  if (isNegation) {
    config.accessLists.delete(aclNumber);
    return { output: '', exitCode: 0 };
  }

  // For adding entries, we need at least action (permit/deny)
  if (args.length < 2) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const action = args[1].toLowerCase() as 'permit' | 'deny';

  // Determine ACL type based on number
  const isStandard = (aclNumber >= 1 && aclNumber <= 99) || (aclNumber >= 1300 && aclNumber <= 1999);
  const isExtended = (aclNumber >= 100 && aclNumber <= 199) || (aclNumber >= 2000 && aclNumber <= 2699);

  if (!isStandard && !isExtended) {
    return { output: '', error: '% Invalid access list number', exitCode: 1 };
  }

  // Get or create ACL
  let acl = config.accessLists.get(aclNumber);
  if (!acl) {
    acl = {
      number: aclNumber,
      type: isStandard ? 'standard' : 'extended',
      entries: [],
    };
    config.accessLists.set(aclNumber, acl);
  }

  // Parse ACL entry
  if (isStandard) {
    const source = args[2] || 'any';
    const sourceWildcard = args[3] || '0.0.0.0';

    const entry: ACLEntry = {
      sequence: (acl.entries.length + 1) * 10,
      action,
      protocol: 'ip',
      sourceIP: source === 'any' ? '0.0.0.0' : source,
      sourceWildcard: source === 'any' ? '255.255.255.255' : sourceWildcard,
      destIP: '0.0.0.0',
      destWildcard: '255.255.255.255',
    };

    acl.entries.push(entry);
  } else {
    // Extended ACL parsing
    const protocol = args[2] || 'ip';
    const sourceIP = args[3] || 'any';
    const sourceWildcard = args[4] || '0.0.0.0';
    const destIP = args[5] || 'any';
    const destWildcard = args[6] || '0.0.0.0';

    const entry: ACLEntry = {
      sequence: (acl.entries.length + 1) * 10,
      action,
      protocol: protocol as any,
      sourceIP: sourceIP === 'any' ? '0.0.0.0' : sourceIP,
      sourceWildcard: sourceIP === 'any' ? '255.255.255.255' : sourceWildcard,
      destIP: destIP === 'any' ? '0.0.0.0' : destIP,
      destWildcard: destIP === 'any' ? '255.255.255.255' : destWildcard,
    };

    // Parse port specifications if present
    for (let i = 7; i < args.length; i++) {
      if (args[i] === 'eq' && args[i + 1]) {
        entry.destPort = { operator: 'eq', ports: [parseInt(args[++i])] };
      } else if (args[i] === 'established') {
        entry.established = true;
      } else if (args[i] === 'log') {
        entry.log = true;
      }
    }

    acl.entries.push(entry);
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure named access list
 */
function configNamedAccessList(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length < 2) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const type = args[0].toLowerCase() as 'standard' | 'extended';
  const name = args[1];

  if (isNegation) {
    config.accessLists.delete(name);
    return { output: '', exitCode: 0 };
  }

  // Get or create ACL
  if (!config.accessLists.has(name)) {
    config.accessLists.set(name, {
      name,
      type,
      entries: [],
    });
  }

  return {
    output: '',
    exitCode: 0,
    newMode: 'acl',
    newACL: name,
  };
}

/**
 * Configure DHCP pool
 */
function configDHCPPool(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const poolName = args[0];

  if (isNegation) {
    config.dhcpPools.delete(poolName);
    return { output: '', exitCode: 0 };
  }

  // Create pool if doesn't exist
  if (!config.dhcpPools.has(poolName)) {
    config.dhcpPools.set(poolName, {
      name: poolName,
      excludedAddresses: [],
    });
  }

  return {
    output: '',
    exitCode: 0,
    newMode: 'dhcp',
    newDHCPPool: poolName,
  };
}

/**
 * Configure DHCP excluded addresses
 */
function configDHCPExcluded(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const startIP = args[0];
  const endIP = args[1];

  if (isNegation) {
    config.dhcpExcluded = config.dhcpExcluded.filter(
      e => !(e.start === startIP && e.end === endIP)
    );
  } else {
    config.dhcpExcluded.push({ start: startIP, end: endIP });
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure NAT
 */
function configNAT(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (!config.nat) {
    config.nat = {
      insideInterfaces: [],
      outsideInterfaces: [],
      staticNAT: [],
      poolNAT: [],
    };
  }

  if (args[0] === 'inside' && args[1] === 'source') {
    if (args[2] === 'static') {
      const inside = args[3];
      const outside = args[4];
      if (isNegation) {
        config.nat.staticNAT = config.nat.staticNAT.filter(
          n => !(n.inside === inside && n.outside === outside)
        );
      } else {
        config.nat.staticNAT.push({ inside, outside });
      }
    } else if (args[2] === 'list') {
      const aclNumber = parseInt(args[3]);
      if (args[4] === 'interface') {
        const iface = args[5];
        if (args[6] === 'overload') {
          config.nat.overload = { aclNumber, interface: iface };
        }
      }
    }
  } else if (args[0] === 'pool') {
    const poolName = args[1];
    const startIP = args[2];
    const endIP = args[3];
    const mask = args[5]; // args[4] is 'netmask'

    if (isNegation) {
      config.nat.poolNAT = config.nat.poolNAT.filter(p => p.name !== poolName);
    } else {
      config.nat.poolNAT.push({ name: poolName, startIP, endIP, mask });
    }
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure NTP
 */
function configNTP(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  if (args[0] === 'server') {
    const server = args[1];
    if (isNegation) {
      config.ntpServer = config.ntpServer?.filter(s => s !== server);
    } else {
      if (!config.ntpServer) config.ntpServer = [];
      config.ntpServer.push(server);
    }
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure clock
 */
function configClock(args: string[], config: CiscoConfig): CiscoCommandResult {
  // Clock configuration is typically done in privileged mode
  return { output: '', exitCode: 0 };
}

/**
 * Configure SNMP
 */
function configSNMP(args: string[], config: CiscoConfig, isNegation: boolean): CiscoCommandResult {
  // SNMP configuration placeholder
  return { output: '', exitCode: 0 };
}

/**
 * Interface configuration mode commands
 */
function executeInterfaceConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  const iface = config.interfaces.get(state.currentInterface!);
  if (!iface) {
    return { output: '', error: '% Invalid interface', exitCode: 1 };
  }

  switch (command) {
    case 'description':
      if (isNegation) {
        iface.description = undefined;
      } else {
        iface.description = args.join(' ');
      }
      return { output: '', exitCode: 0 };

    case 'ip':
      return configInterfaceIP(args, iface, config, isNegation);

    case 'shutdown':
      iface.isAdminDown = !isNegation;
      iface.isUp = !iface.isAdminDown;
      return { output: '', exitCode: 0 };

    case 'speed':
      if (isNegation) {
        iface.speed = 'auto';
      } else {
        iface.speed = args[0] as any || 'auto';
      }
      return { output: '', exitCode: 0 };

    case 'duplex':
      if (isNegation) {
        iface.duplex = 'auto';
      } else {
        iface.duplex = args[0] as any || 'auto';
      }
      return { output: '', exitCode: 0 };

    case 'mtu':
      if (isNegation) {
        iface.mtu = 1500;
      } else {
        iface.mtu = parseInt(args[0]) || 1500;
      }
      return { output: '', exitCode: 0 };

    case 'bandwidth':
      if (isNegation) {
        iface.bandwidth = 1000000;
      } else {
        iface.bandwidth = parseInt(args[0]) || 1000000;
      }
      return { output: '', exitCode: 0 };

    case 'switchport':
      return configSwitchport(args, iface, config, isNegation);

    case 'spanning-tree':
      return configInterfaceSpanningTree(args, iface, isNegation);

    case 'encapsulation':
      return configEncapsulation(args, iface, isNegation);

    case 'exit':
      return {
        output: '',
        exitCode: 0,
        newMode: 'global-config',
      };

    case 'end':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * Configure interface IP settings
 */
function configInterfaceIP(
  args: string[],
  iface: CiscoInterface,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0];

  switch (subCommand) {
    case 'address':
      if (isNegation) {
        iface.ipAddress = undefined;
        iface.subnetMask = undefined;
      } else if (args[1] && args[2]) {
        iface.ipAddress = args[1];
        iface.subnetMask = args[2];

        if (args[3] === 'secondary') {
          if (!iface.secondaryIPs) iface.secondaryIPs = [];
          iface.secondaryIPs.push({ ip: args[1], mask: args[2] });
        }
      } else if (args[1] === 'dhcp') {
        // DHCP client (simulation)
        iface.ipAddress = '192.168.1.100';
        iface.subnetMask = '255.255.255.0';
      }
      return { output: '', exitCode: 0 };

    case 'helper-address':
      if (isNegation) {
        if (iface.ipHelper) {
          iface.ipHelper = iface.ipHelper.filter(h => h !== args[1]);
        }
      } else if (args[1]) {
        if (!iface.ipHelper) iface.ipHelper = [];
        iface.ipHelper.push(args[1]);
      }
      return { output: '', exitCode: 0 };

    case 'ospf':
      return configInterfaceOSPF(args.slice(1), iface, isNegation);

    case 'nat':
      if (args[1] === 'inside') {
        if (!config.nat) {
          config.nat = { insideInterfaces: [], outsideInterfaces: [], staticNAT: [], poolNAT: [] };
        }
        if (isNegation) {
          config.nat.insideInterfaces = config.nat.insideInterfaces.filter(i => i !== iface.name);
        } else {
          config.nat.insideInterfaces.push(iface.name);
        }
      } else if (args[1] === 'outside') {
        if (!config.nat) {
          config.nat = { insideInterfaces: [], outsideInterfaces: [], staticNAT: [], poolNAT: [] };
        }
        if (isNegation) {
          config.nat.outsideInterfaces = config.nat.outsideInterfaces.filter(i => i !== iface.name);
        } else {
          config.nat.outsideInterfaces.push(iface.name);
        }
      }
      return { output: '', exitCode: 0 };

    case 'access-group':
      // Apply ACL to interface
      return { output: '', exitCode: 0 };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * Configure interface OSPF settings
 */
function configInterfaceOSPF(args: string[], iface: CiscoInterface, isNegation: boolean): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  switch (args[0]) {
    case 'cost':
      if (isNegation) {
        iface.ospfCost = undefined;
      } else {
        iface.ospfCost = parseInt(args[1]) || 1;
      }
      break;

    case 'priority':
      if (isNegation) {
        iface.ospfPriority = undefined;
      } else {
        iface.ospfPriority = parseInt(args[1]) || 1;
      }
      break;

    case 'network':
      if (isNegation) {
        iface.ospfNetwork = undefined;
      } else {
        iface.ospfNetwork = args[1] as any;
      }
      break;
  }

  return { output: '', exitCode: 0 };
}

/**
 * Configure switchport settings
 */
function configSwitchport(
  args: string[],
  iface: CiscoInterface,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  if (config.deviceType !== 'switch' && iface.type !== 'FastEthernet' && iface.type !== 'GigabitEthernet') {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  if (args.length === 0) {
    // Enable/disable switchport mode
    return { output: '', exitCode: 0 };
  }

  switch (args[0]) {
    case 'mode':
      if (isNegation) {
        iface.switchportMode = 'dynamic-auto';
      } else {
        const mode = args[1] as 'access' | 'trunk' | 'dynamic-auto' | 'dynamic-desirable';
        if (['access', 'trunk', 'dynamic', 'dynamic-auto', 'dynamic-desirable'].includes(mode)) {
          iface.switchportMode = mode === 'dynamic' ? (args[2] as any) || 'dynamic-auto' : mode;
        }
      }
      return { output: '', exitCode: 0 };

    case 'access':
      if (args[1] === 'vlan') {
        if (isNegation) {
          iface.accessVlan = 1;
        } else {
          const vlanId = parseInt(args[2]);
          if (vlanId >= 1 && vlanId <= 4094) {
            iface.accessVlan = vlanId;
          }
        }
      }
      return { output: '', exitCode: 0 };

    case 'trunk':
      if (args[1] === 'native' && args[2] === 'vlan') {
        if (isNegation) {
          iface.nativeVlan = 1;
        } else {
          iface.nativeVlan = parseInt(args[3]) || 1;
        }
      } else if (args[1] === 'allowed' && args[2] === 'vlan') {
        if (isNegation) {
          iface.allowedVlans = 'all';
        } else if (args[3] === 'add') {
          const currentVlans = iface.allowedVlans || 'all';
          if (currentVlans === 'all') {
            iface.allowedVlans = args[4];
          } else {
            iface.allowedVlans = currentVlans + ',' + args[4];
          }
        } else if (args[3] === 'remove') {
          // Remove specific VLANs
          const vlansToRemove = args[4].split(',');
          const currentVlans = (iface.allowedVlans || '').split(',');
          iface.allowedVlans = currentVlans.filter(v => !vlansToRemove.includes(v)).join(',');
        } else {
          iface.allowedVlans = args[3];
        }
      }
      return { output: '', exitCode: 0 };

    case 'voice':
      if (args[1] === 'vlan') {
        if (isNegation) {
          iface.voiceVlan = undefined;
        } else {
          iface.voiceVlan = parseInt(args[2]);
        }
      }
      return { output: '', exitCode: 0 };

    case 'port-security':
      if (!iface.portSecurity) {
        iface.portSecurity = {
          enabled: true,
          maximum: 1,
          violation: 'shutdown',
          macAddresses: [],
          sticky: false,
        };
      }

      if (args.length === 1) {
        iface.portSecurity.enabled = !isNegation;
      } else if (args[1] === 'maximum') {
        iface.portSecurity.maximum = parseInt(args[2]) || 1;
      } else if (args[1] === 'violation') {
        iface.portSecurity.violation = args[2] as 'protect' | 'restrict' | 'shutdown';
      } else if (args[1] === 'mac-address') {
        if (args[2] === 'sticky') {
          iface.portSecurity.sticky = !isNegation;
        } else if (args[2]) {
          if (isNegation) {
            iface.portSecurity.macAddresses = iface.portSecurity.macAddresses.filter(m => m !== args[2]);
          } else {
            iface.portSecurity.macAddresses.push(args[2]);
          }
        }
      }
      return { output: '', exitCode: 0 };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * Configure interface spanning-tree settings
 */
function configInterfaceSpanningTree(
  args: string[],
  iface: CiscoInterface,
  isNegation: boolean
): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  switch (args[0]) {
    case 'portfast':
      iface.stpPortfast = !isNegation;
      return { output: '', exitCode: 0 };

    case 'bpduguard':
      if (args[1] === 'enable') {
        iface.stpBpduguard = !isNegation;
      }
      return { output: '', exitCode: 0 };

    case 'cost':
      if (isNegation) {
        iface.stpCost = undefined;
      } else {
        iface.stpCost = parseInt(args[1]) || 19;
      }
      return { output: '', exitCode: 0 };

    case 'port-priority':
      if (isNegation) {
        iface.stpPriority = undefined;
      } else {
        iface.stpPriority = parseInt(args[1]) || 128;
      }
      return { output: '', exitCode: 0 };

    default:
      return { output: '', exitCode: 0 };
  }
}

/**
 * Configure encapsulation (for subinterfaces)
 */
function configEncapsulation(
  args: string[],
  iface: CiscoInterface,
  isNegation: boolean
): CiscoCommandResult {
  if (args[0] === 'dot1q' && args[1]) {
    if (isNegation) {
      iface.accessVlan = undefined;
    } else {
      iface.accessVlan = parseInt(args[1]);
      if (args[2] === 'native') {
        iface.nativeVlan = iface.accessVlan;
      }
    }
  }
  return { output: '', exitCode: 0 };
}

/**
 * Line configuration mode commands
 */
function executeLineConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  const lineType = state.currentLine?.type || 'console';
  let lineConfig: LineConfig;

  if (lineType === 'console') {
    lineConfig = config.lineConsole;
  } else if (lineType === 'vty') {
    lineConfig = config.lineVty[0] || {
      type: 'vty',
      startLine: 0,
      endLine: 15,
      login: false,
      loginLocal: false,
      execTimeout: { minutes: 10, seconds: 0 },
      loggingSynchronous: false,
    };
  } else {
    lineConfig = config.lineAux || {
      type: 'aux',
      startLine: 0,
      login: false,
      loginLocal: false,
      execTimeout: { minutes: 10, seconds: 0 },
      loggingSynchronous: false,
    };
  }

  switch (command) {
    case 'password':
      if (isNegation) {
        lineConfig.password = undefined;
      } else {
        lineConfig.password = args[0];
      }
      return { output: '', exitCode: 0 };

    case 'login':
      if (args[0] === 'local') {
        lineConfig.loginLocal = !isNegation;
        lineConfig.login = false;
      } else {
        lineConfig.login = !isNegation;
        lineConfig.loginLocal = false;
      }
      return { output: '', exitCode: 0 };

    case 'exec-timeout':
      if (isNegation) {
        lineConfig.execTimeout = { minutes: 10, seconds: 0 };
      } else {
        lineConfig.execTimeout = {
          minutes: parseInt(args[0]) || 10,
          seconds: parseInt(args[1]) || 0,
        };
      }
      return { output: '', exitCode: 0 };

    case 'transport':
      if (args[0] === 'input') {
        if (isNegation) {
          lineConfig.transportInput = ['none'];
        } else {
          lineConfig.transportInput = args.slice(1) as ('telnet' | 'ssh' | 'all' | 'none')[];
        }
      } else if (args[0] === 'output') {
        if (isNegation) {
          lineConfig.transportOutput = ['none'];
        } else {
          lineConfig.transportOutput = args.slice(1) as ('telnet' | 'ssh' | 'all' | 'none')[];
        }
      }
      return { output: '', exitCode: 0 };

    case 'logging':
      if (args[0] === 'synchronous') {
        lineConfig.loggingSynchronous = !isNegation;
      }
      return { output: '', exitCode: 0 };

    case 'exit':
      return {
        output: '',
        exitCode: 0,
        newMode: 'global-config',
      };

    case 'end':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * Router configuration mode commands
 */
function executeRouterConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  const protocol = state.currentRouter?.protocol;

  switch (command) {
    case 'network':
      if (!args[0]) {
        return { output: '', error: '% Incomplete command.', exitCode: 1 };
      }

      if (protocol === 'ospf' && config.ospf) {
        const network = args[0];
        const wildcardMask = args[1] || '0.0.0.0';
        const area = parseInt(args[3]) || 0; // args[2] is 'area'

        if (isNegation) {
          config.ospf.networks = config.ospf.networks.filter(
            n => !(n.network === network && n.wildcardMask === wildcardMask)
          );
        } else {
          config.ospf.networks.push({ network, wildcardMask, area });
        }
      } else if (protocol === 'eigrp' && config.eigrp) {
        if (isNegation) {
          config.eigrp.networks = config.eigrp.networks.filter(n => n !== args[0]);
        } else {
          config.eigrp.networks.push(args[0]);
        }
      } else if (protocol === 'rip' && config.rip) {
        if (isNegation) {
          config.rip.networks = config.rip.networks.filter(n => n !== args[0]);
        } else {
          config.rip.networks.push(args[0]);
        }
      }
      return { output: '', exitCode: 0 };

    case 'router-id':
      if (protocol === 'ospf' && config.ospf) {
        config.ospf.routerId = isNegation ? undefined : args[0];
      } else if (protocol === 'eigrp' && config.eigrp) {
        config.eigrp.routerId = isNegation ? undefined : args[0];
      }
      return { output: '', exitCode: 0 };

    case 'passive-interface':
      const passiveIface = args[0] === 'default' ? 'default' : expandInterfaceName(args.join(''));

      if (protocol === 'ospf' && config.ospf) {
        if (isNegation) {
          config.ospf.passiveInterfaces = config.ospf.passiveInterfaces.filter(i => i !== passiveIface);
        } else {
          config.ospf.passiveInterfaces.push(passiveIface);
        }
      } else if (protocol === 'eigrp' && config.eigrp) {
        if (isNegation) {
          config.eigrp.passiveInterfaces = config.eigrp.passiveInterfaces.filter(i => i !== passiveIface);
        } else {
          config.eigrp.passiveInterfaces.push(passiveIface);
        }
      } else if (protocol === 'rip' && config.rip) {
        if (isNegation) {
          config.rip.passiveInterfaces = config.rip.passiveInterfaces.filter(i => i !== passiveIface);
        } else {
          config.rip.passiveInterfaces.push(passiveIface);
        }
      }
      return { output: '', exitCode: 0 };

    case 'default-information':
      if (args[0] === 'originate') {
        if (protocol === 'ospf' && config.ospf) {
          config.ospf.defaultInformationOriginate = !isNegation;
        } else if (protocol === 'rip' && config.rip) {
          config.rip.defaultInformationOriginate = !isNegation;
        }
      }
      return { output: '', exitCode: 0 };

    case 'redistribute':
      if (protocol === 'ospf' && config.ospf) {
        if (args[0] === 'static') {
          config.ospf.redistributeStatic = !isNegation;
        } else if (args[0] === 'connected') {
          config.ospf.redistributeConnected = !isNegation;
        }
      }
      return { output: '', exitCode: 0 };

    case 'version':
      if (protocol === 'rip' && config.rip) {
        config.rip.version = parseInt(args[0]) === 1 ? 1 : 2;
      }
      return { output: '', exitCode: 0 };

    case 'auto-summary':
      if (protocol === 'eigrp' && config.eigrp) {
        config.eigrp.autoSummary = !isNegation;
      } else if (protocol === 'rip' && config.rip) {
        config.rip.autoSummary = !isNegation;
      }
      return { output: '', exitCode: 0 };

    case 'exit':
      return {
        output: '',
        exitCode: 0,
        newMode: 'global-config',
      };

    case 'end':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * VLAN configuration mode commands
 */
function executeVlanConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  const vlanId = state.currentVlan;
  if (!vlanId) {
    return { output: '', error: '% Invalid VLAN', exitCode: 1 };
  }

  const vlan = config.vlans.get(vlanId);
  if (!vlan) {
    return { output: '', error: '% Invalid VLAN', exitCode: 1 };
  }

  switch (command) {
    case 'name':
      if (isNegation) {
        vlan.name = `VLAN${String(vlanId).padStart(4, '0')}`;
      } else {
        vlan.name = args.join(' ') || vlan.name;
      }
      return { output: '', exitCode: 0 };

    case 'state':
      if (args[0] === 'active') {
        vlan.state = 'active';
      } else if (args[0] === 'suspend') {
        vlan.state = 'suspend';
      }
      return { output: '', exitCode: 0 };

    case 'shutdown':
      vlan.shutdown = !isNegation;
      return { output: '', exitCode: 0 };

    case 'mtu':
      if (isNegation) {
        vlan.mtu = 1500;
      } else {
        vlan.mtu = parseInt(args[0]) || 1500;
      }
      return { output: '', exitCode: 0 };

    case 'exit':
      return {
        output: '',
        exitCode: 0,
        newMode: 'global-config',
      };

    case 'end':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * DHCP configuration mode commands
 */
function executeDHCPConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  const poolName = state.currentDHCPPool;
  if (!poolName) {
    return { output: '', error: '% Invalid DHCP pool', exitCode: 1 };
  }

  const pool = config.dhcpPools.get(poolName);
  if (!pool) {
    return { output: '', error: '% Invalid DHCP pool', exitCode: 1 };
  }

  switch (command) {
    case 'network':
      if (isNegation) {
        pool.network = undefined;
        pool.mask = undefined;
      } else {
        pool.network = args[0];
        pool.mask = args[1];
      }
      return { output: '', exitCode: 0 };

    case 'default-router':
      if (isNegation) {
        pool.defaultRouter = undefined;
      } else {
        pool.defaultRouter = args;
      }
      return { output: '', exitCode: 0 };

    case 'dns-server':
      if (isNegation) {
        pool.dnsServer = undefined;
      } else {
        pool.dnsServer = args;
      }
      return { output: '', exitCode: 0 };

    case 'domain-name':
      if (isNegation) {
        pool.domain = undefined;
      } else {
        pool.domain = args[0];
      }
      return { output: '', exitCode: 0 };

    case 'lease':
      if (isNegation) {
        pool.leaseTime = undefined;
      } else {
        pool.leaseTime = {
          days: parseInt(args[0]) || 1,
          hours: parseInt(args[1]) || 0,
          minutes: parseInt(args[2]) || 0,
        };
      }
      return { output: '', exitCode: 0 };

    case 'exit':
      return {
        output: '',
        exitCode: 0,
        newMode: 'global-config',
      };

    case 'end':
      return {
        output: '',
        exitCode: 0,
        newMode: 'privileged',
      };

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * ACL configuration mode commands
 */
function executeACLConfig(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  isNegation: boolean
): CiscoCommandResult {
  const aclId = state.currentACL;
  if (!aclId) {
    return { output: '', error: '% Invalid ACL', exitCode: 1 };
  }

  const acl = config.accessLists.get(aclId);
  if (!acl) {
    return { output: '', error: '% Invalid ACL', exitCode: 1 };
  }

  // Handle sequence number removal
  if (isNegation && !isNaN(parseInt(command))) {
    const seqNum = parseInt(command);
    acl.entries = acl.entries.filter(e => e.sequence !== seqNum);
    return { output: '', exitCode: 0 };
  }

  // Handle command starting with sequence number (e.g., "10 permit ...")
  let action: 'permit' | 'deny';
  let sequence: number;
  let aclArgs: string[];

  if (!isNaN(parseInt(command))) {
    // Command is a sequence number, action should be in args[0]
    sequence = parseInt(command);
    if (args[0] !== 'permit' && args[0] !== 'deny') {
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
    }
    action = args[0] as 'permit' | 'deny';
    aclArgs = args.slice(1);
  } else if (command === 'permit' || command === 'deny') {
    action = command as 'permit' | 'deny';
    sequence = (acl.entries.length + 1) * 10;
    aclArgs = args;
  } else {
    // Not a permit/deny command, handle other commands
    switch (command) {
      case 'remark':
        return { output: '', exitCode: 0 };
      case 'exit':
        return { output: '', exitCode: 0, newMode: 'global-config' };
      case 'end':
        return { output: '', exitCode: 0, newMode: 'privileged' };
      default:
        return { output: '', error: '% Invalid input detected', exitCode: 1 };
    }
  }

  // Handle permit/deny entries
  {
    if (acl.type === 'standard') {
      const source = aclArgs[0] || 'any';
      const sourceWildcard = aclArgs[1] || '0.0.0.0';

      const entry: ACLEntry = {
        sequence,
        action,
        protocol: 'ip',
        sourceIP: source === 'any' ? '0.0.0.0' : source,
        sourceWildcard: source === 'any' ? '255.255.255.255' : sourceWildcard,
        destIP: '0.0.0.0',
        destWildcard: '255.255.255.255',
      };

      // Insert in sequence order
      const insertIdx = acl.entries.findIndex(e => e.sequence > sequence);
      if (insertIdx >= 0) {
        acl.entries.splice(insertIdx, 0, entry);
      } else {
        acl.entries.push(entry);
      }
    } else {
      // Extended ACL - parse with proper handling of 'any' and 'host' keywords
      const protocol = aclArgs[0] || 'ip';
      let idx = 1;

      // Parse source
      let sourceIP = '0.0.0.0';
      let sourceWildcard = '255.255.255.255';
      if (aclArgs[idx] === 'any') {
        sourceIP = '0.0.0.0';
        sourceWildcard = '255.255.255.255';
        idx++;
      } else if (aclArgs[idx] === 'host') {
        idx++;
        sourceIP = aclArgs[idx] || '0.0.0.0';
        sourceWildcard = '0.0.0.0';
        idx++;
      } else if (aclArgs[idx]) {
        sourceIP = aclArgs[idx];
        idx++;
        sourceWildcard = aclArgs[idx] || '0.0.0.0';
        idx++;
      }

      // Parse destination
      let destIP = '0.0.0.0';
      let destWildcard = '255.255.255.255';
      if (aclArgs[idx] === 'any') {
        destIP = '0.0.0.0';
        destWildcard = '255.255.255.255';
        idx++;
      } else if (aclArgs[idx] === 'host') {
        idx++;
        destIP = aclArgs[idx] || '0.0.0.0';
        destWildcard = '0.0.0.0';
        idx++;
      } else if (aclArgs[idx]) {
        destIP = aclArgs[idx];
        idx++;
        destWildcard = aclArgs[idx] || '0.0.0.0';
        idx++;
      }

      const entry: ACLEntry = {
        sequence,
        action,
        protocol: protocol as any,
        sourceIP,
        sourceWildcard,
        destIP,
        destWildcard,
      };

      // Parse additional options (eq, established, log, etc.)
      while (idx < aclArgs.length) {
        if (aclArgs[idx] === 'eq' && aclArgs[idx + 1]) {
          entry.destPort = { operator: 'eq', ports: [parseInt(aclArgs[idx + 1])] };
          idx += 2;
        } else if (aclArgs[idx] === 'established') {
          entry.established = true;
          idx++;
        } else if (aclArgs[idx] === 'log') {
          entry.log = true;
          idx++;
        } else {
          idx++;
        }
      }

      const insertIdx = acl.entries.findIndex(e => e.sequence > sequence);
      if (insertIdx >= 0) {
        acl.entries.splice(insertIdx, 0, entry);
      } else {
        acl.entries.push(entry);
      }
    }

    return { output: '', exitCode: 0 };
  }
}
