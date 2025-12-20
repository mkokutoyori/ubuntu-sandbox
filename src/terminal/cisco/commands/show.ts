/**
 * Cisco IOS Show Commands
 * Implements all major show commands for router and switch
 */

import {
  CiscoConfig,
  CiscoTerminalState,
  CiscoCommandResult,
  CiscoInterface,
  RealDeviceData,
  formatCiscoMAC,
  subnetMaskToPrefix,
} from '../types';
import { formatUptime, generateRunningConfig, generateStartupConfig } from '../state';

/**
 * Execute show command
 */
export function executeShowCommand(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  bootTime: Date,
  realDeviceData?: RealDeviceData
): CiscoCommandResult {
  if (args.length === 0) {
    return {
      output: '',
      error: '% Incomplete command.',
      exitCode: 1,
    };
  }

  const subCommand = args[0].toLowerCase();
  const subArgs = args.slice(1);

  switch (subCommand) {
    case 'running-config':
    case 'run':
      return showRunningConfig(config, subArgs);

    case 'startup-config':
    case 'start':
      return showStartupConfig(config);

    case 'version':
    case 'ver':
      return showVersion(config, bootTime);

    case 'interfaces':
    case 'int':
      return showInterfaces(config, subArgs, realDeviceData);

    case 'interface':
      return showInterface(config, subArgs, realDeviceData);

    case 'ip':
      return showIP(config, subArgs, realDeviceData);

    case 'vlan':
      return showVlan(config, subArgs);

    case 'mac':
      if (subArgs[0] === 'address-table') {
        return showMACAddressTable(config, subArgs.slice(1), realDeviceData);
      }
      return { output: '', error: '% Invalid input detected', exitCode: 1 };

    case 'arp':
      return showARP(config, realDeviceData);

    case 'history':
      return showHistory(state);

    case 'clock':
      return showClock();

    case 'users':
      return showUsers();

    case 'privilege':
      return showPrivilege(state);

    case 'spanning-tree':
      return showSpanningTree(config, subArgs);

    case 'cdp':
      return showCDP(config, subArgs);

    case 'protocols':
      return showProtocols(config);

    case 'controllers':
      return showControllers(config);

    case 'flash':
    case 'flash:':
      return showFlash();

    case 'logging':
      return showLogging(config);

    case 'access-lists':
    case 'access-list':
      return showAccessLists(config, subArgs);

    case 'hosts':
      return showHosts(config);

    case 'sessions':
      return showSessions();

    case 'tcp':
      return showTCP(subArgs);

    case 'inventory':
      return showInventory(config);

    case '?':
      return showHelp();

    default:
      return {
        output: '',
        error: `% Invalid input detected at '^' marker.\n\nshow ${subCommand}\n     ^`,
        exitCode: 1,
      };
  }
}

function showRunningConfig(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (args.length > 0) {
    const section = args[0].toLowerCase();
    if (section === 'interface' && args[1]) {
      const ifaceName = args.slice(1).join('');
      const iface = findInterface(config, ifaceName);
      if (iface) {
        return {
          output: formatInterfaceConfig(iface, config),
          exitCode: 0,
        };
      }
      return { output: '', error: '% Invalid interface', exitCode: 1 };
    }
  }

  return {
    output: generateRunningConfig(config),
    exitCode: 0,
    moreOutput: true,
  };
}

function showStartupConfig(config: CiscoConfig): CiscoCommandResult {
  return {
    output: generateStartupConfig(config),
    exitCode: 0,
    moreOutput: true,
  };
}

function showVersion(config: CiscoConfig, bootTime: Date): CiscoCommandResult {
  const isRouter = config.deviceType === 'router';
  const model = isRouter ? 'Cisco ISR4331' : 'Cisco WS-C2960-24TT-L';
  const ios = isRouter ? 'IOS XE Software' : 'IOS Software';
  const processor = isRouter ? 'ISR4331' : 'C2960';
  const ram = isRouter ? '4194304K' : '131072K';
  const flash = isRouter ? '7341807K' : '65536K';

  const output = `Cisco ${ios}, Version 15.1(4)M12, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2024 by Cisco Systems, Inc.
Compiled Tue 04-Mar-24 12:00

ROM: System Bootstrap, Version 15.1(4)M12, RELEASE SOFTWARE (fc1)

${config.hostname} upance is ${formatUptime(bootTime)}
System returned to ROM by power-on
System image file is "flash:c${isRouter ? '4331' : '2960'}-adventerprisek9-mz.SPA.151-4.M12.bin"

This product contains cryptographic features and is subject to United
States and local country laws governing import, export, transfer and
use. Delivery of Cisco cryptographic products does not imply
third-party authority to import, export, distribute or use encryption.

Cisco ${model} (${processor}) processor with ${ram}/${ram} bytes of memory.
Processor board ID FTX1234ABCD
${config.interfaces.size} ${isRouter ? 'Gigabit' : 'Fast'}Ethernet interfaces
${isRouter ? '2 Serial interfaces' : '2 Gigabit Ethernet interfaces'}
${flash} bytes of flash at flash:.

Configuration register is 0x2102`;

  return { output, exitCode: 0 };
}

function showInterfaces(config: CiscoConfig, args: string[], realDeviceData?: RealDeviceData): CiscoCommandResult {
  if (args.length > 0) {
    const section = args[0].toLowerCase();
    if (section === 'status') {
      return showInterfacesStatus(config, realDeviceData);
    }
    if (section === 'trunk') {
      return showInterfacesTrunk(config);
    }
    if (section === 'switchport') {
      return showInterfacesSwitchport(config);
    }
    if (section === 'description') {
      return showInterfacesDescription(config, realDeviceData);
    }
  }

  // Full interface details - use real data if available
  const lines: string[] = [];

  if (realDeviceData && realDeviceData.interfaces.length > 0) {
    for (const iface of realDeviceData.interfaces) {
      lines.push(formatRealInterfaceDetails(iface));
      lines.push('');
    }
  } else {
    for (const [name, iface] of config.interfaces) {
      lines.push(formatInterfaceDetails(iface));
      lines.push('');
    }
  }

  return { output: lines.join('\n'), exitCode: 0, moreOutput: true };
}

function formatRealInterfaceDetails(iface: RealDeviceData['interfaces'][0]): string {
  const status = iface.isUp ? 'up' : 'down';
  const protocol = iface.isUp ? 'up' : 'down';

  const lines: string[] = [
    `${iface.name} is ${status}, line protocol is ${protocol}`,
    `  Hardware is ${iface.type}, address is ${formatCiscoMAC(iface.macAddress)} (bia ${formatCiscoMAC(iface.macAddress)})`,
  ];

  if (iface.ipAddress) {
    lines.push(`  Internet address is ${iface.ipAddress}/${subnetMaskToPrefix(iface.subnetMask || '255.255.255.0')}`);
  }

  lines.push(`  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,`);
  lines.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
  lines.push(`  Encapsulation ARPA, loopback not set`);
  lines.push(`  Keepalive set (10 sec)`);

  if (iface.type.includes('Ethernet')) {
    lines.push(`  Full-duplex, 1000Mb/s, media type is RJ45`);
    lines.push(`  output flow-control is unsupported, input flow-control is unsupported`);
    lines.push(`  ARP type: ARPA, ARP Timeout 04:00:00`);
  }

  lines.push(`  Last input never, output never, output hang never`);
  lines.push(`  Last clearing of "show interface" counters never`);
  lines.push(`  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0`);
  lines.push(`  Queueing strategy: fifo`);
  lines.push(`  Output queue: 0/40 (size/max)`);
  lines.push(`  5 minute input rate 0 bits/sec, 0 packets/sec`);
  lines.push(`  5 minute output rate 0 bits/sec, 0 packets/sec`);
  lines.push(`     0 packets input, 0 bytes, 0 no buffer`);
  lines.push(`     Received 0 broadcasts (0 multicasts)`);
  lines.push(`     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored`);
  lines.push(`     0 watchdog, 0 multicast, 0 pause input`);
  lines.push(`     0 packets output, 0 bytes, 0 underruns`);
  lines.push(`     0 output errors, 0 collisions, 0 interface resets`);
  lines.push(`     0 unknown protocol drops`);
  lines.push(`     0 babbles, 0 late collision, 0 deferred`);
  lines.push(`     0 lost carrier, 0 no carrier, 0 pause output`);
  lines.push(`     0 output buffer failures, 0 output buffers swapped out`);

  return lines.join('\n');
}

function showInterfacesStatus(config: CiscoConfig, realDeviceData?: RealDeviceData): CiscoCommandResult {
  const lines: string[] = [
    'Port      Name               Status       Vlan       Duplex  Speed Type',
    '--------- ------------------ ------------ ---------- ------- ----- ----',
  ];

  // Use real device data if available
  if (realDeviceData && realDeviceData.interfaces.length > 0) {
    for (const iface of realDeviceData.interfaces) {
      if (iface.type === 'Loopback') continue;

      const shortName = getShortInterfaceName(iface.name);
      const desc = ''.padEnd(18);
      const status = iface.isUp ? 'connected' : 'notconnect';
      const vlan = '1';
      const type = iface.type.includes('Gig') ? '10/100/1000BaseTX' : '10/100BaseTX';

      lines.push(
        `${shortName.padEnd(10)}${desc} ${status.padEnd(12)} ${vlan.padEnd(10)} ${'auto'.padEnd(7)} ${'auto'.padEnd(5)} ${type}`
      );
    }
  } else {
    for (const [name, iface] of config.interfaces) {
      if (iface.type === 'Loopback') continue;

      const shortName = getShortInterfaceName(name);
      const desc = (iface.description || '').substring(0, 18).padEnd(18);
      const status = iface.isAdminDown ? 'disabled' : (iface.isUp ? 'connected' : 'notconnect');
      const vlan = iface.switchportMode === 'trunk' ? 'trunk' : String(iface.accessVlan || 1);
      const duplex = iface.duplex === 'auto' ? 'auto' : iface.duplex;
      const speed = iface.speed === 'auto' ? 'auto' : iface.speed;
      const type = iface.type.includes('Gig') ? '10/100/1000BaseTX' : '10/100BaseTX';

      lines.push(
        `${shortName.padEnd(10)}${desc} ${status.padEnd(12)} ${vlan.padEnd(10)} ${duplex.padEnd(7)} ${speed.padEnd(5)} ${type}`
      );
    }
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showInterfacesTrunk(config: CiscoConfig): CiscoCommandResult {
  const trunkPorts = Array.from(config.interfaces.values()).filter(
    i => i.switchportMode === 'trunk'
  );

  if (trunkPorts.length === 0) {
    return { output: '', exitCode: 0 };
  }

  const lines: string[] = [
    'Port        Mode         Encapsulation  Status        Native vlan',
    '--------- ------------ -------------- ------------- -----------',
  ];

  for (const iface of trunkPorts) {
    const shortName = getShortInterfaceName(iface.name);
    const status = iface.isUp ? 'trunking' : 'not-trunking';
    lines.push(
      `${shortName.padEnd(10)} on           802.1q         ${status.padEnd(13)} ${iface.nativeVlan || 1}`
    );
  }

  lines.push('');
  lines.push('Port        Vlans allowed on trunk');
  lines.push('--------- ---------------------------');
  for (const iface of trunkPorts) {
    lines.push(`${getShortInterfaceName(iface.name).padEnd(10)} ${iface.allowedVlans || 'all'}`);
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showInterfacesSwitchport(config: CiscoConfig): CiscoCommandResult {
  const lines: string[] = [];

  for (const [name, iface] of config.interfaces) {
    if (iface.type === 'Loopback' || iface.type === 'Vlan') continue;

    lines.push(`Name: ${name}`);
    lines.push(`Switchport: Enabled`);
    lines.push(`Administrative Mode: ${iface.switchportMode || 'dynamic auto'}`);
    lines.push(`Operational Mode: ${iface.switchportMode === 'trunk' ? 'trunk' : 'access'}`);
    lines.push(`Administrative Trunking Encapsulation: dot1q`);
    lines.push(`Negotiation of Trunking: On`);
    lines.push(`Access Mode VLAN: ${iface.accessVlan || 1} (${config.vlans.get(iface.accessVlan || 1)?.name || 'default'})`);
    lines.push(`Trunking Native Mode VLAN: ${iface.nativeVlan || 1} (${config.vlans.get(iface.nativeVlan || 1)?.name || 'default'})`);
    lines.push(`Voice VLAN: ${iface.voiceVlan || 'none'}`);
    lines.push('');
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showInterfacesDescription(config: CiscoConfig, realDeviceData?: RealDeviceData): CiscoCommandResult {
  const lines: string[] = [
    'Interface                      Status         Protocol Description',
    '------------------------------  -------------  -------- -----------',
  ];

  // Use real device data if available
  if (realDeviceData && realDeviceData.interfaces.length > 0) {
    for (const iface of realDeviceData.interfaces) {
      const status = iface.isUp ? 'up' : 'down';
      const protocol = iface.isUp ? 'up' : 'down';
      lines.push(
        `${iface.name.padEnd(31)} ${status.padEnd(14)} ${protocol.padEnd(8)} `
      );
    }
  } else {
    for (const [name, iface] of config.interfaces) {
      const status = iface.isAdminDown ? 'admin down' : (iface.isUp ? 'up' : 'down');
      const protocol = iface.isUp ? 'up' : 'down';
      lines.push(
        `${name.padEnd(31)} ${status.padEnd(14)} ${protocol.padEnd(8)} ${iface.description || ''}`
      );
    }
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showInterface(config: CiscoConfig, args: string[], realDeviceData?: RealDeviceData): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const ifaceName = args.join('');

  // Try to find in real device data first
  if (realDeviceData && realDeviceData.interfaces.length > 0) {
    const expandedName = expandInterfaceName(ifaceName);
    const realIface = realDeviceData.interfaces.find(
      i => i.name.toLowerCase() === expandedName.toLowerCase() ||
           i.name.toLowerCase().startsWith(expandedName.toLowerCase()) ||
           i.id === ifaceName
    );
    if (realIface) {
      return { output: formatRealInterfaceDetails(realIface), exitCode: 0 };
    }
  }

  const iface = findInterface(config, ifaceName);

  if (!iface) {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  return { output: formatInterfaceDetails(iface), exitCode: 0 };
}

function formatInterfaceDetails(iface: CiscoInterface): string {
  const status = iface.isAdminDown
    ? 'administratively down'
    : iface.isUp
    ? 'up'
    : 'down';
  const protocol = iface.isUp ? 'up' : 'down';

  const lines: string[] = [
    `${iface.name} is ${status}, line protocol is ${protocol}`,
    `  Hardware is ${iface.type}, address is ${formatCiscoMAC(iface.macAddress)} (bia ${formatCiscoMAC(iface.macAddress)})`,
  ];

  if (iface.description) {
    lines.push(`  Description: ${iface.description}`);
  }

  if (iface.ipAddress) {
    lines.push(`  Internet address is ${iface.ipAddress}/${subnetMaskToPrefix(iface.subnetMask || '255.255.255.0')}`);
  }

  lines.push(`  MTU ${iface.mtu} bytes, BW ${iface.bandwidth} Kbit/sec, DLY ${iface.delay} usec,`);
  lines.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
  lines.push(`  Encapsulation ${iface.type.includes('Ethernet') ? 'ARPA' : 'HDLC'}, loopback not set`);
  lines.push(`  Keepalive set (10 sec)`);

  if (iface.type.includes('Ethernet')) {
    lines.push(`  Full-duplex, ${iface.speed === 'auto' ? '1000Mb/s' : iface.speed + 'Mb/s'}, media type is RJ45`);
    lines.push(`  output flow-control is unsupported, input flow-control is unsupported`);
    lines.push(`  ARP type: ARPA, ARP Timeout 04:00:00`);
  }

  lines.push(`  Last input ${iface.lastInput ? formatTime(iface.lastInput) : 'never'}, output ${iface.lastOutput ? formatTime(iface.lastOutput) : 'never'}, output hang never`);
  lines.push(`  Last clearing of "show interface" counters never`);
  lines.push(`  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0`);
  lines.push(`  Queueing strategy: fifo`);
  lines.push(`  Output queue: 0/40 (size/max)`);
  lines.push(`  5 minute input rate 0 bits/sec, 0 packets/sec`);
  lines.push(`  5 minute output rate 0 bits/sec, 0 packets/sec`);
  lines.push(`     ${iface.inputPackets} packets input, ${iface.inputPackets * 64} bytes, 0 no buffer`);
  lines.push(`     Received 0 broadcasts (0 multicasts)`);
  lines.push(`     ${iface.inputErrors} input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored`);
  lines.push(`     0 watchdog, 0 multicast, 0 pause input`);
  lines.push(`     ${iface.outputPackets} packets output, ${iface.outputPackets * 64} bytes, 0 underruns`);
  lines.push(`     ${iface.outputErrors} output errors, ${iface.collisions} collisions, 0 interface resets`);
  lines.push(`     0 unknown protocol drops`);
  lines.push(`     0 babbles, 0 late collision, 0 deferred`);
  lines.push(`     0 lost carrier, 0 no carrier, 0 pause output`);
  lines.push(`     0 output buffer failures, 0 output buffers swapped out`);

  return lines.join('\n');
}

function formatInterfaceConfig(iface: CiscoInterface, config: CiscoConfig): string {
  const lines: string[] = [];
  lines.push(`Building configuration...`);
  lines.push(``);
  lines.push(`Current configuration : 128 bytes`);
  lines.push(`!`);
  lines.push(`interface ${iface.name}`);

  if (iface.description) {
    lines.push(` description ${iface.description}`);
  }

  if (config.deviceType === 'switch' && iface.type !== 'Loopback' && iface.type !== 'Vlan') {
    if (iface.switchportMode === 'access') {
      lines.push(` switchport mode access`);
      if (iface.accessVlan && iface.accessVlan !== 1) {
        lines.push(` switchport access vlan ${iface.accessVlan}`);
      }
    } else if (iface.switchportMode === 'trunk') {
      lines.push(` switchport mode trunk`);
    }
  } else {
    if (iface.ipAddress) {
      lines.push(` ip address ${iface.ipAddress} ${iface.subnetMask}`);
    } else {
      lines.push(` no ip address`);
    }
  }

  if (iface.isAdminDown) {
    lines.push(` shutdown`);
  }

  lines.push(`end`);

  return lines.join('\n');
}

function showIP(config: CiscoConfig, args: string[], realDeviceData?: RealDeviceData): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0].toLowerCase();

  switch (subCommand) {
    case 'route':
      return showIPRoute(config, realDeviceData);
    case 'interface':
      return showIPInterface(config, args.slice(1), realDeviceData);
    case 'protocols':
      return showIPProtocols(config);
    case 'arp':
      return showARP(config, realDeviceData);
    case 'int':
    case 'brief':
      return showIPInterfaceBrief(config, realDeviceData);
    case 'ospf':
      return showIPOSPF(config, args.slice(1));
    case 'eigrp':
      return showIPEIGRP(config, args.slice(1));
    case 'access-lists':
      return showAccessLists(config, args.slice(1));
    case 'dhcp':
      return showIPDHCP(config, args.slice(1));
    case 'nat':
      return showIPNAT(config, args.slice(1));
    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

function showIPRoute(config: CiscoConfig, realDeviceData?: RealDeviceData): CiscoCommandResult {
  if (!config.ipRouting && config.deviceType !== 'router') {
    return { output: 'IP routing is disabled', exitCode: 0 };
  }

  const lines: string[] = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
    '       E1 - OSPF external type 1, E2 - OSPF external type 2',
    '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
    '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
    '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
    '       a - application route',
    '       + - replicated route, % - next hop override, p - overrides from PfR',
    '',
    'Gateway of last resort is not set',
    '',
  ];

  // Use real device data if available
  if (realDeviceData && realDeviceData.routingTable.length > 0) {
    for (const route of realDeviceData.routingTable) {
      const prefix = netmaskToPrefix(route.netmask);
      let code = 'S';
      if (route.protocol === 'connected') {
        code = 'C';
      } else if (route.protocol === 'local') {
        code = 'L';
      } else if (route.protocol === 'static') {
        code = 'S';
      }

      if (route.protocol === 'connected' || route.protocol === 'local') {
        lines.push(`${code}        ${route.destination}/${prefix} is directly connected, ${route.interface}`);
      } else {
        const nextHop = route.gateway !== '0.0.0.0' ? route.gateway : route.interface;
        lines.push(`${code}        ${route.destination}/${prefix} [1/${route.metric}] via ${nextHop}, ${route.interface}`);
      }
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  // Fallback to config-based display
  // Add connected routes from interfaces
  for (const [name, iface] of config.interfaces) {
    if (iface.ipAddress && iface.isUp && !iface.isAdminDown) {
      const prefix = subnetMaskToPrefix(iface.subnetMask || '255.255.255.0');
      const network = getNetworkAddress(iface.ipAddress, iface.subnetMask || '255.255.255.0');
      lines.push(`C        ${network}/${prefix} is directly connected, ${name}`);
      lines.push(`L        ${iface.ipAddress}/32 is directly connected, ${name}`);
    }
  }

  // Add static routes
  for (const route of config.staticRoutes) {
    const prefix = subnetMaskToPrefix(route.mask);
    const nextHop = route.nextHop || route.interface;
    lines.push(`S        ${route.network}/${prefix} [${route.administrativeDistance}/${route.metric || 0}] via ${nextHop}`);
  }

  // Add OSPF routes
  if (config.ospf) {
    // Simulated OSPF routes would be shown here
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

// Helper to convert netmask to prefix length
function netmaskToPrefix(netmask: string): number {
  const octets = netmask.split('.').map(Number);
  let prefix = 0;
  for (const octet of octets) {
    prefix += (octet >>> 0).toString(2).split('1').length - 1;
  }
  return prefix;
}

function showIPInterface(config: CiscoConfig, args: string[], realDeviceData?: RealDeviceData): CiscoCommandResult {
  if (args.length === 0 || args[0].toLowerCase() === 'brief') {
    return showIPInterfaceBrief(config, realDeviceData);
  }

  const ifaceName = args.join('');
  const iface = findInterface(config, ifaceName);

  if (!iface) {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  const lines: string[] = [
    `${iface.name} is ${iface.isAdminDown ? 'administratively down' : iface.isUp ? 'up' : 'down'}, line protocol is ${iface.isUp ? 'up' : 'down'}`,
  ];

  if (iface.ipAddress) {
    lines.push(`  Internet address is ${iface.ipAddress}/${subnetMaskToPrefix(iface.subnetMask || '255.255.255.0')}`);
    lines.push(`  Broadcast address is ${getBroadcastAddress(iface.ipAddress, iface.subnetMask || '255.255.255.0')}`);
  } else {
    lines.push(`  Internet protocol processing disabled`);
  }

  lines.push(`  MTU is ${iface.mtu} bytes`);
  lines.push(`  Helper address is not set`);
  lines.push(`  Directed broadcast forwarding is disabled`);
  lines.push(`  Outgoing Common access list is not set`);
  lines.push(`  Outgoing access list is not set`);
  lines.push(`  Inbound Common access list is not set`);
  lines.push(`  Inbound access list is not set`);
  lines.push(`  Proxy ARP is enabled`);
  lines.push(`  Local Proxy ARP is disabled`);
  lines.push(`  Security level is default`);
  lines.push(`  Split horizon is enabled`);
  lines.push(`  ICMP redirects are always sent`);
  lines.push(`  ICMP unreachables are always sent`);
  lines.push(`  ICMP mask replies are never sent`);
  lines.push(`  IP fast switching is enabled`);
  lines.push(`  IP fast switching on the same interface is disabled`);
  lines.push(`  IP Flow switching is disabled`);
  lines.push(`  IP CEF switching is enabled`);
  lines.push(`  IP CEF switching turbo vector`);

  return { output: lines.join('\n'), exitCode: 0 };
}

function showIPInterfaceBrief(config: CiscoConfig, realDeviceData?: RealDeviceData): CiscoCommandResult {
  const lines: string[] = [
    'Interface              IP-Address      OK? Method Status                Protocol',
  ];

  // Use real device data if available
  if (realDeviceData && realDeviceData.interfaces.length > 0) {
    for (const iface of realDeviceData.interfaces) {
      const ip = iface.ipAddress || 'unassigned';
      const ok = 'YES';
      const method = iface.ipAddress ? 'manual' : 'unset';
      const status = iface.isUp ? 'up' : 'down';
      const protocol = iface.isUp ? 'up' : 'down';

      lines.push(
        `${iface.name.padEnd(23)}${ip.padEnd(16)}${ok.padEnd(4)}${method.padEnd(7)}${status.padEnd(22)}${protocol}`
      );
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  // Fallback to config-based display
  for (const [name, iface] of config.interfaces) {
    const ip = iface.ipAddress || 'unassigned';
    const ok = 'YES';
    const method = iface.ipAddress ? 'manual' : 'unset';
    const status = iface.isAdminDown
      ? 'administratively down'
      : iface.isUp
      ? 'up'
      : 'down';
    const protocol = iface.isUp ? 'up' : 'down';

    lines.push(
      `${name.padEnd(23)}${ip.padEnd(16)}${ok.padEnd(4)}${method.padEnd(7)}${status.padEnd(22)}${protocol}`
    );
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showIPProtocols(config: CiscoConfig): CiscoCommandResult {
  const lines: string[] = [];

  if (config.ospf) {
    lines.push(`*** IP Routing is NSF aware ***`);
    lines.push(``);
    lines.push(`Routing Protocol is "ospf ${config.ospf.processId}"`);
    lines.push(`  Outgoing update filter list for all interfaces is not set`);
    lines.push(`  Incoming update filter list for all interfaces is not set`);
    lines.push(`  Router ID ${config.ospf.routerId || '0.0.0.0'}`);
    lines.push(`  Number of areas in this router is 1. 1 normal 0 stub 0 nssa`);
    lines.push(`  Maximum path: 4`);
    lines.push(`  Routing for Networks:`);
    for (const network of config.ospf.networks) {
      lines.push(`    ${network.network} ${network.wildcardMask} area ${network.area}`);
    }
    if (config.ospf.passiveInterfaces.length > 0) {
      lines.push(`  Passive Interface(s):`);
      for (const iface of config.ospf.passiveInterfaces) {
        lines.push(`    ${iface}`);
      }
    }
    lines.push(`  Routing Information Sources:`);
    lines.push(`    Gateway         Distance      Last Update`);
    lines.push(`  Distance: (default is 110)`);
    lines.push(``);
  }

  if (config.eigrp) {
    lines.push(`Routing Protocol is "eigrp ${config.eigrp.asNumber}"`);
    lines.push(`  Outgoing update filter list for all interfaces is not set`);
    lines.push(`  Incoming update filter list for all interfaces is not set`);
    lines.push(`  Default networks flagged in outgoing updates`);
    lines.push(`  Default networks accepted from incoming updates`);
    lines.push(`  EIGRP-IPv4 Protocol for AS(${config.eigrp.asNumber})`);
    lines.push(`    Metric weight K1=1, K2=0, K3=1, K4=0, K5=0`);
    lines.push(`    Soft SIA disabled`);
    lines.push(`    NSF-aware route hold timer is 240`);
    lines.push(`    Router-ID: ${config.eigrp.routerId || '0.0.0.0'}`);
    lines.push(`    Automatic Summarization: ${config.eigrp.autoSummary ? 'enabled' : 'disabled'}`);
    lines.push(`  Maximum path: 4`);
    lines.push(`  Routing for Networks:`);
    for (const network of config.eigrp.networks) {
      lines.push(`    ${network}`);
    }
    lines.push(``);
  }

  if (config.rip) {
    lines.push(`Routing Protocol is "rip"`);
    lines.push(`  Outgoing update filter list for all interfaces is not set`);
    lines.push(`  Incoming update filter list for all interfaces is not set`);
    lines.push(`  Sending updates every 30 seconds, next due in ${Math.floor(Math.random() * 30)} seconds`);
    lines.push(`  Invalid after 180 seconds, hold down 180, flushed after 240`);
    lines.push(`  Redistributing: rip`);
    lines.push(`  Default version control: send version ${config.rip.version}, receive version ${config.rip.version}`);
    lines.push(`  Automatic network summarization is ${config.rip.autoSummary ? 'in effect' : 'not in effect'}`);
    lines.push(`  Maximum path: 4`);
    lines.push(`  Routing for Networks:`);
    for (const network of config.rip.networks) {
      lines.push(`    ${network}`);
    }
    lines.push(``);
  }

  if (lines.length === 0) {
    lines.push(`*** IP Routing is NSF aware ***`);
    lines.push(``);
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showIPOSPF(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (!config.ospf) {
    return { output: '% OSPF: No router process configured', exitCode: 0 };
  }

  if (args.length === 0) {
    const lines: string[] = [
      `Routing Process "ospf ${config.ospf.processId}" with ID ${config.ospf.routerId || '0.0.0.0'}`,
      `Start time: 00:00:01.123, Time elapsed: 01:23:45.678`,
      `Supports only single TOS(TOS0) routes`,
      `Supports opaque LSA`,
      `Supports Link-local Signaling (LLS)`,
      `Supports area transit capability`,
      `Supports NSSA (compatible with RFC 3101)`,
      `Event-log enabled, Maximum number of events: 1000, Mode: cyclic`,
      `Router is not originating router-LSAs with maximum metric`,
      `Initial SPF schedule delay 5000 msecs`,
      `Minimum hold time between two consecutive SPFs 10000 msecs`,
      `Maximum wait time between two consecutive SPFs 10000 msecs`,
      `Incremental-SPF disabled`,
      `Minimum LSA interval 5 secs`,
      `Minimum LSA arrival 1000 msecs`,
      `LSA group pacing timer 240 secs`,
      `Interface flood pacing timer 33 msecs`,
      `Retransmission pacing timer 66 msecs`,
      `Number of external LSA 0. Checksum Sum 0x000000`,
      `Number of opaque AS LSA 0. Checksum Sum 0x000000`,
      `Number of DCbitless external and opaque AS LSA 0`,
      `Number of DoNotAge external and opaque AS LSA 0`,
      `Number of areas in this router is 1. 1 normal 0 stub 0 nssa`,
      `Number of areas transit capable is 0`,
      `External flood list length 0`,
      `    Area BACKBONE(0)`,
      `        Number of interfaces in this area is ${config.ospf.networks.length}`,
      `        Area has no authentication`,
      `        SPF algorithm last executed 00:01:23.456 ago`,
      `        SPF algorithm executed 5 times`,
      `        Area ranges are`,
      `        Number of LSA 5. Checksum Sum 0x012345`,
      `        Number of opaque link LSA 0. Checksum Sum 0x000000`,
      `        Number of DCbitless LSA 0`,
      `        Number of indication LSA 0`,
      `        Number of DoNotAge LSA 0`,
      `        Flood list length 0`,
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  if (args[0] === 'neighbor') {
    return showOSPFNeighbor(config);
  }

  if (args[0] === 'interface') {
    return showOSPFInterface(config, args.slice(1));
  }

  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

function showOSPFNeighbor(config: CiscoConfig): CiscoCommandResult {
  const lines: string[] = [
    'Neighbor ID     Pri   State           Dead Time   Address         Interface',
  ];
  // In a real implementation, this would show actual neighbors
  return { output: lines.join('\n'), exitCode: 0 };
}

function showOSPFInterface(config: CiscoConfig, args: string[]): CiscoCommandResult {
  const lines: string[] = [];

  for (const [name, iface] of config.interfaces) {
    if (!iface.ipAddress || iface.isAdminDown) continue;

    lines.push(`${name} is ${iface.isUp ? 'up' : 'down'}, line protocol is ${iface.isUp ? 'up' : 'down'}`);
    lines.push(`  Internet Address ${iface.ipAddress}/${subnetMaskToPrefix(iface.subnetMask || '255.255.255.0')}, Area 0`);
    lines.push(`  Process ID ${config.ospf?.processId || 1}, Router ID ${config.ospf?.routerId || '0.0.0.0'}, Network Type BROADCAST, Cost: ${iface.ospfCost || 1}`);
    lines.push(`  Transmit Delay is 1 sec, State DR, Priority ${iface.ospfPriority || 1}`);
    lines.push(`  Designated Router (ID) ${config.ospf?.routerId || '0.0.0.0'}, Interface address ${iface.ipAddress}`);
    lines.push(`  No backup designated router on this network`);
    lines.push(`  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5`);
    lines.push(`    oob-resync timeout 40`);
    lines.push(`    Hello due in 00:00:05`);
    lines.push(`  Supports Link-local Signaling (LLS)`);
    lines.push(`  Cisco NSF helper support enabled`);
    lines.push(`  IETF NSF helper support enabled`);
    lines.push(`  Index 1/1, flood queue length 0`);
    lines.push(`  Next 0x0(0)/0x0(0)`);
    lines.push(`  Last flood scan length is 0, maximum is 0`);
    lines.push(`  Last flood scan time is 0 msec, maximum is 0 msec`);
    lines.push(`  Neighbor Count is 0, Adjacent neighbor count is 0`);
    lines.push(`  Suppress hello for 0 neighbor(s)`);
    lines.push(``);
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showIPEIGRP(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (!config.eigrp) {
    // EIGRP not configured - return empty output with success
    if (args[0] === 'neighbors') {
      return {
        output: 'EIGRP-IPv4 Neighbors for AS(0)\nH   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq\n                                                   (sec)         (ms)       Cnt Num',
        exitCode: 0
      };
    }
    return { output: '', exitCode: 0 };
  }

  if (args[0] === 'neighbors') {
    const lines: string[] = [
      `EIGRP-IPv4 Neighbors for AS(${config.eigrp.asNumber})`,
      'H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq',
      '                                                   (sec)         (ms)       Cnt Num',
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  if (args[0] === 'topology') {
    const lines: string[] = [
      `EIGRP-IPv4 Topology Table for AS(${config.eigrp.asNumber})/ID(${config.eigrp.routerId || '0.0.0.0'})`,
      '',
      'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
      '       r - reply Status, s - sia Status',
      '',
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

function showIPDHCP(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (args[0] === 'pool') {
    const lines: string[] = [];
    for (const [name, pool] of config.dhcpPools) {
      lines.push(`Pool ${name} :`);
      lines.push(` Utilization mark (high/low)    : 100 / 0`);
      lines.push(` Subnet size (first/next)       : 0 / 0`);
      lines.push(` Total addresses                : 254`);
      lines.push(` Leased addresses               : 0`);
      lines.push(` Pending event                  : none`);
      lines.push(` 1 subnet is currently in the pool :`);
      lines.push(` Current index        IP address range                    Leased/Excluded/Total`);
      if (pool.network && pool.mask) {
        lines.push(` ${pool.network}        ${pool.network} - ${getBroadcastAddress(pool.network, pool.mask)}   0 / 0 / 254`);
      }
      lines.push(``);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  if (args[0] === 'binding') {
    return { output: 'Bindings from all pools not associated with VRF:\nIP address      Client-ID/              Lease expiration        Type       State\n', exitCode: 0 };
  }

  return { output: '', error: '% Incomplete command.', exitCode: 1 };
}

function showIPNAT(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (args[0] === 'translations') {
    const lines: string[] = [
      'Pro Inside global      Inside local       Outside local      Outside global',
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  if (args[0] === 'statistics') {
    const lines: string[] = [
      'Total active translations: 0 (0 static, 0 dynamic; 0 extended)',
      'Outside interfaces:',
      'Inside interfaces:',
      'Hits: 0  Misses: 0',
      'CEF Translated packets: 0, CEF Punted packets: 0',
      'Expired translations: 0',
      'Dynamic mappings:',
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  return { output: '', error: '% Incomplete command.', exitCode: 1 };
}

function showVlan(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (config.deviceType !== 'switch') {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  if (args.length > 0 && args[0] === 'brief') {
    const lines: string[] = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    for (const [id, vlan] of config.vlans) {
      const ports = getVlanPorts(config, id);
      lines.push(
        `${String(id).padEnd(5)}${vlan.name.padEnd(33)}${vlan.state.padEnd(10)}${ports.slice(0, 4).join(', ')}`
      );
      if (ports.length > 4) {
        lines.push(`                                                ${ports.slice(4, 8).join(', ')}`);
      }
    }

    return { output: lines.join('\n'), exitCode: 0 };
  }

  // Full VLAN display
  const lines: string[] = [
    'VLAN Name                             Status    Ports',
    '---- -------------------------------- --------- -------------------------------',
  ];

  for (const [id, vlan] of config.vlans) {
    const ports = getVlanPorts(config, id);
    lines.push(
      `${String(id).padEnd(5)}${vlan.name.padEnd(33)}${vlan.state.padEnd(10)}${ports.slice(0, 4).join(', ')}`
    );
    if (ports.length > 4) {
      for (let i = 4; i < ports.length; i += 4) {
        lines.push(`                                                ${ports.slice(i, i + 4).join(', ')}`);
      }
    }
  }

  lines.push('');
  lines.push('VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2');
  lines.push('---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------');

  for (const [id, vlan] of config.vlans) {
    lines.push(
      `${String(id).padEnd(5)}enet  ${String(100000 + id).padEnd(11)}${String(vlan.mtu).padEnd(6)}-      -      -        -    -        0      0`
    );
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showMACAddressTable(config: CiscoConfig, args: string[], realDeviceData?: RealDeviceData): CiscoCommandResult {
  if (config.deviceType !== 'switch') {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  const lines: string[] = [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
  ];

  // Use real device data if available
  if (realDeviceData && realDeviceData.macTable && realDeviceData.macTable.length > 0) {
    for (const entry of realDeviceData.macTable) {
      lines.push(
        ` ${String(entry.vlan).padEnd(7)} ${entry.macAddress.padEnd(17)} ${entry.type.padEnd(11)} ${entry.ports}`
      );
    }
    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${realDeviceData.macTable.length}`);
  } else {
    for (const entry of config.macTable) {
      lines.push(
        ` ${String(entry.vlan).padEnd(7)} ${entry.macAddress.padEnd(17)} ${entry.type.padEnd(11)} ${entry.ports}`
      );
    }
    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${config.macTable.length}`);
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showARP(config: CiscoConfig, realDeviceData?: RealDeviceData): CiscoCommandResult {
  const lines: string[] = [
    'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
  ];

  // Use real device data if available
  if (realDeviceData && realDeviceData.arpTable.length > 0) {
    for (const entry of realDeviceData.arpTable) {
      const age = entry.age !== undefined ? entry.age : 0;
      const formattedMac = formatCiscoMAC(entry.macAddress);
      lines.push(
        `${'Internet'.padEnd(10)}${entry.ipAddress.padEnd(17)}${String(age).padEnd(11)}${formattedMac.padEnd(16)}${'ARPA'.padEnd(7)}${entry.interface}`
      );
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  // Fallback to config-based display
  for (const entry of config.arpTable) {
    lines.push(
      `${entry.protocol.padEnd(10)}${entry.address.padEnd(17)}${String(entry.age).padEnd(11)}${entry.hardwareAddr.padEnd(16)}${entry.type.padEnd(7)}${entry.interface}`
    );
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showHistory(state: CiscoTerminalState): CiscoCommandResult {
  const lines = state.history.map((cmd, idx) => `  ${idx + 1}  ${cmd}`);
  return { output: lines.join('\n'), exitCode: 0 };
}

function showClock(): CiscoCommandResult {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const time = now.toTimeString().split(' ')[0];
  const day = days[now.getDay()];
  const month = months[now.getMonth()];
  const date = now.getDate();
  const year = now.getFullYear();

  return {
    output: `*${time}.${String(now.getMilliseconds()).padStart(3, '0')} UTC ${day} ${month} ${date} ${year}`,
    exitCode: 0,
  };
}

function showUsers(): CiscoCommandResult {
  return {
    output: `    Line       User       Host(s)              Idle       Location
*  0 con 0                idle                 00:00:00`,
    exitCode: 0,
  };
}

function showPrivilege(state: CiscoTerminalState): CiscoCommandResult {
  const level = state.mode === 'user' ? 1 : 15;
  return { output: `Current privilege level is ${level}`, exitCode: 0 };
}

function showSpanningTree(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (config.deviceType !== 'switch') {
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  const lines: string[] = [];

  for (const [vlanId, vlan] of config.vlans) {
    if (vlan.shutdown) continue;

    lines.push(`VLAN${String(vlanId).padStart(4, '0')}`);
    lines.push(`  Spanning tree enabled protocol ${config.stpMode || 'ieee'}`);
    lines.push(`  Root ID    Priority    ${vlanId + 32768}`);
    lines.push(`             Address     ${generateCiscoMAC()}`);
    lines.push(`             This bridge is the root`);
    lines.push(`             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec`);
    lines.push(``);
    lines.push(`  Bridge ID  Priority    ${vlanId + 32768}  (priority ${32768} sys-id-ext ${vlanId})`);
    lines.push(`             Address     ${generateCiscoMAC()}`);
    lines.push(`             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec`);
    lines.push(`             Aging Time  300 sec`);
    lines.push(``);
    lines.push(`Interface           Role Sts Cost      Prio.Nbr Type`);
    lines.push(`------------------- ---- --- --------- -------- --------------------------------`);

    for (const [name, iface] of config.interfaces) {
      if (iface.isAdminDown || iface.type === 'Loopback') continue;
      const shortName = getShortInterfaceName(name);
      const role = 'Desg';
      const sts = iface.stpPortfast ? 'FWD' : 'FWD';
      const cost = iface.stpCost || (iface.type === 'GigabitEthernet' ? 4 : 19);
      const priority = iface.stpPriority || 128;
      const type = iface.stpPortfast ? 'P2p Edge' : 'P2p';

      lines.push(
        `${shortName.padEnd(20)}${role} ${sts} ${String(cost).padEnd(10)}${priority}.${name.match(/\d+$/)?.[0] || '1'}   ${type}`
      );
    }
    lines.push(``);
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showCDP(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (!config.cdpEnabled) {
    return { output: '% CDP is not enabled', exitCode: 0 };
  }

  if (args[0] === 'neighbors') {
    const lines: string[] = [
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
      '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,',
      '                  D - Remote, C - CVTA, M - Two-port Mac Relay',
      '',
      'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
    ];
    return { output: lines.join('\n'), exitCode: 0 };
  }

  return {
    output: `Global CDP information:
        Sending CDP packets every 60 seconds
        Sending a holdtime value of 180 seconds
        Sending CDPv2 advertisements is enabled`,
    exitCode: 0,
  };
}

function showProtocols(config: CiscoConfig): CiscoCommandResult {
  const lines: string[] = [
    'Global values:',
    `  Internet Protocol routing is ${config.ipRouting ? 'enabled' : 'disabled'}`,
  ];

  for (const [name, iface] of config.interfaces) {
    lines.push(`${name} is ${iface.isAdminDown ? 'administratively down' : iface.isUp ? 'up' : 'down'}, line protocol is ${iface.isUp ? 'up' : 'down'}`);
    if (iface.ipAddress) {
      lines.push(`  Internet address is ${iface.ipAddress}/${subnetMaskToPrefix(iface.subnetMask || '255.255.255.0')}`);
    }
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showControllers(config: CiscoConfig): CiscoCommandResult {
  const lines: string[] = [];
  for (const [name, iface] of config.interfaces) {
    if (iface.type === 'Serial') {
      lines.push(`${name}`);
      lines.push(`Hardware is PowerQUICC MPC860`);
      lines.push(`DTE V.35 TX and RX clocks detected`);
      lines.push(`idb at 0x81081AC4, driver data structure at 0x81084AC0`);
      lines.push(``);
    }
  }
  return { output: lines.join('\n') || 'No controllers', exitCode: 0 };
}

function showFlash(): CiscoCommandResult {
  return {
    output: `-#- --length-- -----date/time------ path
  1      123456 Mar 01 2024 12:00:00 +00:00 c2960-lanbasek9-mz.150-2.SE11.bin
  2        2048 Mar 01 2024 12:00:00 +00:00 config.text
  3        1024 Mar 01 2024 12:00:00 +00:00 vlan.dat

65536000 bytes total (65400000 bytes free)`,
    exitCode: 0,
  };
}

function showLogging(config: CiscoConfig): CiscoCommandResult {
  return {
    output: `Syslog logging: enabled (0 messages dropped, 0 messages rate-limited)

No Active Message Discriminator.

No Inactive Message Discriminator.

    Console logging: ${config.loggingConsole ? 'level debugging' : 'disabled'}
    Monitor logging: level debugging, 0 messages logged
    Buffer logging:  ${config.loggingBuffered ? 'level debugging' : 'disabled'}, 0 messages logged
    Logging Exception size (4096 bytes)
    Count and timestamp logging messages: disabled
    Persistent logging: disabled

No active filter modules.`,
    exitCode: 0,
  };
}

function showAccessLists(config: CiscoConfig, args: string[]): CiscoCommandResult {
  if (config.accessLists.size === 0) {
    return { output: '', exitCode: 0 };
  }

  const lines: string[] = [];

  for (const [id, acl] of config.accessLists) {
    if (typeof id === 'number') {
      lines.push(`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${id}`);
    } else {
      lines.push(`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${id}`);
    }

    for (const entry of acl.entries) {
      let line = `    ${entry.sequence} ${entry.action} ${entry.protocol}`;
      line += ` ${entry.sourceIP === '0.0.0.0' && entry.sourceWildcard === '255.255.255.255' ? 'any' : entry.sourceIP + ' ' + entry.sourceWildcard}`;
      if (acl.type === 'extended') {
        line += ` ${entry.destIP === '0.0.0.0' && entry.destWildcard === '255.255.255.255' ? 'any' : entry.destIP + ' ' + entry.destWildcard}`;
      }
      lines.push(line);
    }
  }

  return { output: lines.join('\n'), exitCode: 0 };
}

function showHosts(config: CiscoConfig): CiscoCommandResult {
  return {
    output: `Default domain is ${config.domainName || 'not set'}
Name/address lookup uses domain service
Name servers are ${config.nameServers.length > 0 ? config.nameServers.join(', ') : '255.255.255.255'}`,
    exitCode: 0,
  };
}

function showSessions(): CiscoCommandResult {
  return { output: '% No connections open', exitCode: 0 };
}

function showTCP(args: string[]): CiscoCommandResult {
  if (args[0] === 'brief') {
    return {
      output: `TCB       Local Address               Foreign Address             (state)`,
      exitCode: 0,
    };
  }
  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

function showInventory(config: CiscoConfig): CiscoCommandResult {
  const isRouter = config.deviceType === 'router';
  return {
    output: `NAME: "Chassis", DESCR: "Cisco ${isRouter ? 'ISR4331' : 'WS-C2960-24TT-L'} Chassis"
PID: ${isRouter ? 'ISR4331/K9' : 'WS-C2960-24TT-L'} , VID: V01, SN: FTX1234ABCD

NAME: "Power Supply Module 0", DESCR: "Cisco ${isRouter ? 'ISR4331' : '2960'} AC Power Supply"
PID: ${isRouter ? 'PWR-4330-AC' : 'PWR-2960-AC'}  , VID: V01, SN: PSU1234ABCD`,
    exitCode: 0,
  };
}

function showHelp(): CiscoCommandResult {
  return {
    output: `  access-lists      List access lists
  arp               ARP table
  cdp               CDP information
  clock             Display the system clock
  controllers       Interface controllers status
  flash:            Flash file system
  history           Display the session command history
  hosts             IP domain-name, lookup style, nameservers, and host table
  interfaces        Interface status and configuration
  inventory         Physical inventory
  ip                IP information
  logging           Logging buffer
  mac               MAC configuration
  privilege         Show current privilege level
  protocols         Active network routing protocols
  running-config    Current operating configuration
  sessions          Information about Telnet connections
  spanning-tree     Spanning tree topology
  startup-config    Contents of startup configuration
  tcp               Status of TCP connections
  users             Display information about terminal lines
  version           System hardware and software status
  vlan              VTP VLAN status`,
    exitCode: 0,
  };
}

// Helper functions
function findInterface(config: CiscoConfig, name: string): CiscoInterface | undefined {
  // Try exact match first
  if (config.interfaces.has(name)) {
    return config.interfaces.get(name);
  }

  // Try expanded name
  const expanded = expandInterfaceName(name);
  if (config.interfaces.has(expanded)) {
    return config.interfaces.get(expanded);
  }

  // Try to find by partial match
  for (const [ifName, iface] of config.interfaces) {
    if (ifName.toLowerCase().startsWith(expanded.toLowerCase())) {
      return iface;
    }
  }

  return undefined;
}

function expandInterfaceName(name: string): string {
  const abbreviations: Record<string, string> = {
    gi: 'GigabitEthernet',
    gig: 'GigabitEthernet',
    fa: 'FastEthernet',
    fas: 'FastEthernet',
    se: 'Serial',
    ser: 'Serial',
    lo: 'Loopback',
    vl: 'Vlan',
    tu: 'Tunnel',
    po: 'Port-channel',
    te: 'TenGigabitEthernet',
  };

  const match = name.match(/^([a-zA-Z-]+)([\d\/\.]+)?$/);
  if (!match) return name;

  const prefix = match[1].toLowerCase();
  const suffix = match[2] || '';

  return (abbreviations[prefix] || match[1]) + suffix;
}

function getShortInterfaceName(name: string): string {
  return name
    .replace('GigabitEthernet', 'Gi')
    .replace('FastEthernet', 'Fa')
    .replace('TenGigabitEthernet', 'Te')
    .replace('Serial', 'Se')
    .replace('Loopback', 'Lo')
    .replace('Port-channel', 'Po')
    .replace('Vlan', 'Vl');
}

function getVlanPorts(config: CiscoConfig, vlanId: number): string[] {
  const ports: string[] = [];
  for (const [name, iface] of config.interfaces) {
    if (iface.switchportMode === 'access' && iface.accessVlan === vlanId && !iface.isAdminDown) {
      ports.push(getShortInterfaceName(name));
    }
  }
  return ports;
}

function getNetworkAddress(ip: string, mask: string): string {
  const ipOctets = ip.split('.').map(Number);
  const maskOctets = mask.split('.').map(Number);
  return ipOctets.map((o, i) => o & maskOctets[i]).join('.');
}

function getBroadcastAddress(ip: string, mask: string): string {
  const ipOctets = ip.split('.').map(Number);
  const maskOctets = mask.split('.').map(Number);
  return ipOctets.map((o, i) => o | (255 - maskOctets[i])).join('.');
}

function formatTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function generateCiscoMAC(): string {
  const hexDigits = '0123456789abcdef';
  let mac = '0000.0c';
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0 && i > 0) mac += '.';
    mac += hexDigits[Math.floor(Math.random() * 16)];
  }
  return mac;
}
