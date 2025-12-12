/**
 * Cisco IOS Command Dispatcher
 * Main entry point for command execution
 */

import {
  CiscoConfig,
  CiscoTerminalState,
  CiscoCommandResult,
  CiscoMode,
  generateId,
} from '../types';
import { executeShowCommand } from './show';
import { executeConfigCommand } from './config';

/**
 * Parse command input into command and arguments
 */
export function parseCommand(input: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return {
    command: tokens[0]?.toLowerCase() || '',
    args: tokens.slice(1),
  };
}

/**
 * Execute a command in the given mode
 */
export function executeCiscoCommand(
  input: string,
  state: CiscoTerminalState,
  config: CiscoConfig,
  bootTime: Date
): CiscoCommandResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { output: '', exitCode: 0 };
  }

  // Handle ? for context-sensitive help
  if (trimmed === '?') {
    return getContextHelp(state, config);
  }

  // Handle partial command with ?
  if (trimmed.endsWith('?')) {
    return getPartialHelp(trimmed.slice(0, -1).trim(), state, config);
  }

  const { command, args } = parseCommand(trimmed);

  // Route to appropriate handler based on mode
  switch (state.mode) {
    case 'user':
      return executeUserCommand(command, args, state, config, bootTime);

    case 'privileged':
      return executePrivilegedCommand(command, args, state, config, bootTime);

    case 'global-config':
    case 'interface':
    case 'subinterface':
    case 'line':
    case 'router':
    case 'vlan':
    case 'dhcp':
    case 'acl':
    case 'route-map':
      return executeConfigModeCommand(command, args, state, config, bootTime);

    default:
      return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }
}

/**
 * User EXEC mode commands (Router>)
 */
function executeUserCommand(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  bootTime: Date
): CiscoCommandResult {
  switch (command) {
    case 'enable':
    case 'en':
      return handleEnable(args, state, config);

    case 'exit':
    case 'quit':
    case 'logout':
      return { output: '', exitCode: 0, newMode: 'user' }; // Exit terminal

    case 'ping':
      return executePing(args, config);

    case 'traceroute':
    case 'trace':
      return executeTraceroute(args, config);

    case 'show':
    case 'sh':
      // Limited show commands in user mode
      return executeLimitedShow(args, state, config, bootTime);

    case 'terminal':
      return executeTerminal(args, state);

    case 'connect':
    case 'telnet':
      return executeTelnet(args);

    case 'ssh':
      return executeSSH(args);

    case 'disable':
      return { output: '', exitCode: 0 }; // Already in user mode

    case '?':
      return getUserHelp();

    default:
      // Try abbreviated commands
      const expanded = expandCommand(command, getUserCommands());
      if (expanded && expanded !== command) {
        return executeUserCommand(expanded, args, state, config, bootTime);
      }
      return { output: '', error: `% Unknown command or computer name, or unable to find computer address`, exitCode: 1 };
  }
}

/**
 * Privileged EXEC mode commands (Router#)
 */
function executePrivilegedCommand(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  bootTime: Date
): CiscoCommandResult {
  switch (command) {
    case 'configure':
    case 'conf':
      if (args[0] === 'terminal' || args[0] === 't' || args.length === 0) {
        return {
          output: 'Enter configuration commands, one per line.  End with CNTL/Z.',
          exitCode: 0,
          newMode: 'global-config',
        };
      }
      return { output: '', error: '% Invalid input detected', exitCode: 1 };

    case 'show':
    case 'sh':
      return executeShowCommand(args, state, config, bootTime);

    case 'write':
    case 'wr':
      return executeWrite(args, state, config);

    case 'copy':
      return executeCopy(args, state, config);

    case 'erase':
      return executeErase(args, config);

    case 'reload':
      return executeReload(args, state);

    case 'clear':
      return executeClear(args, config);

    case 'debug':
      return executeDebug(args, config);

    case 'undebug':
      return executeUndebug(args, config);

    case 'ping':
      return executePing(args, config);

    case 'traceroute':
    case 'trace':
      return executeTraceroute(args, config);

    case 'telnet':
      return executeTelnet(args);

    case 'ssh':
      return executeSSH(args);

    case 'disable':
      return {
        output: '',
        exitCode: 0,
        newMode: 'user',
      };

    case 'exit':
    case 'quit':
    case 'logout':
      return {
        output: '',
        exitCode: 0,
        newMode: 'user',
      };

    case 'terminal':
      return executeTerminal(args, state);

    case 'clock':
      return executeClock(args);

    case 'delete':
      return executeDelete(args);

    case 'dir':
      return executeDir(args);

    case 'more':
      return executeMore(args);

    case 'verify':
      return executeVerify(args);

    case '?':
      return getPrivilegedHelp();

    default:
      // Try abbreviated commands
      const expanded = expandCommand(command, getPrivilegedCommands());
      if (expanded && expanded !== command) {
        return executePrivilegedCommand(expanded, args, state, config, bootTime);
      }
      return { output: '', error: `% Invalid input detected at '^' marker.`, exitCode: 1 };
  }
}

/**
 * Configuration mode commands
 */
function executeConfigModeCommand(
  command: string,
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  bootTime: Date
): CiscoCommandResult {
  // Handle 'do' prefix for privileged commands
  if (command === 'do') {
    const doCommand = args[0];
    const doArgs = args.slice(1);
    if (doCommand === 'show' || doCommand === 'sh') {
      return executeShowCommand(doArgs, state, config, bootTime);
    }
    if (doCommand === 'write' || doCommand === 'wr') {
      return executeWrite(doArgs, state, config);
    }
    if (doCommand === 'ping') {
      return executePing(doArgs, config);
    }
    if (doCommand === 'clear') {
      return executeClear(doArgs, config);
    }
    return { output: '', error: '% Invalid input detected', exitCode: 1 };
  }

  // Handle exit/end in any config mode
  if (command === 'end') {
    return {
      output: '',
      exitCode: 0,
      newMode: 'privileged',
    };
  }

  if (command === 'exit') {
    // Go up one level
    const parentMode = getParentMode(state.mode);
    return {
      output: '',
      exitCode: 0,
      newMode: parentMode,
    };
  }

  // Handle ? for help
  if (command === '?') {
    return getConfigHelp(state.mode);
  }

  // Delegate to config command handler
  return executeConfigCommand(command, args, state, config);
}

/**
 * Handle enable command with optional password
 */
function handleEnable(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig
): CiscoCommandResult {
  // Check if enable password/secret is set
  if (config.enableSecret || config.enablePassword) {
    // In a real implementation, we would prompt for password
    // For simulation, we'll accept any password or skip
    state.isAuthenticated = true;
  }

  return {
    output: '',
    exitCode: 0,
    newMode: 'privileged',
  };
}

/**
 * Execute ping command
 */
function executePing(args: string[], config: CiscoConfig): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const target = args[0];
  const count = 5;

  const lines: string[] = [
    `Type escape sequence to abort.`,
    `Sending ${count}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
  ];

  // Simulate ping responses
  let successes = 0;
  let responses = '';

  for (let i = 0; i < count; i++) {
    // Simulate ~80% success rate for demonstration
    if (Math.random() > 0.2) {
      responses += '!';
      successes++;
    } else {
      responses += '.';
    }
  }

  lines.push(responses);
  lines.push(`Success rate is ${Math.round((successes / count) * 100)} percent (${successes}/${count})`);

  if (successes > 0) {
    const minTime = 1 + Math.floor(Math.random() * 10);
    const maxTime = minTime + Math.floor(Math.random() * 20);
    const avgTime = Math.floor((minTime + maxTime) / 2);
    lines.push(`round-trip min/avg/max = ${minTime}/${avgTime}/${maxTime} ms`);
  }

  return { output: lines.join('\n'), exitCode: successes > 0 ? 0 : 1 };
}

/**
 * Execute traceroute command
 */
function executeTraceroute(args: string[], config: CiscoConfig): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const target = args[0];

  const lines: string[] = [
    `Type escape sequence to abort.`,
    `Tracing the route to ${target}`,
    `VRF info: (vrf in name/id, vrf out name/id)`,
  ];

  // Simulate a few hops
  const hops = 2 + Math.floor(Math.random() * 4);
  for (let i = 1; i <= hops; i++) {
    const hopIP = `10.${i}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const time1 = 1 + Math.floor(Math.random() * 20);
    const time2 = 1 + Math.floor(Math.random() * 20);
    const time3 = 1 + Math.floor(Math.random() * 20);
    lines.push(`  ${i}   ${hopIP}   ${time1} msec   ${time2} msec   ${time3} msec`);
  }

  // Final hop is the target
  const time1 = 1 + Math.floor(Math.random() * 30);
  const time2 = 1 + Math.floor(Math.random() * 30);
  const time3 = 1 + Math.floor(Math.random() * 30);
  lines.push(`  ${hops + 1}   ${target}   ${time1} msec   ${time2} msec   ${time3} msec`);

  return { output: lines.join('\n'), exitCode: 0 };
}

/**
 * Execute write command
 */
function executeWrite(args: string[], state: CiscoTerminalState, config: CiscoConfig): CiscoCommandResult {
  if (args.length === 0 || args[0] === 'memory' || args[0] === 'mem') {
    state.configModified = false;
    return {
      output: `Building configuration...
[OK]`,
      exitCode: 0,
    };
  }

  if (args[0] === 'terminal' || args[0] === 'term') {
    // This would show running config, delegate to show
    return executeShowCommand(['running-config'], state, config, new Date());
  }

  if (args[0] === 'erase') {
    return {
      output: `Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]
[OK]
Erase of nvram: complete`,
      exitCode: 0,
    };
  }

  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

/**
 * Execute copy command
 */
function executeCopy(args: string[], state: CiscoTerminalState, config: CiscoConfig): CiscoCommandResult {
  if (args.length < 2) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const source = args[0];
  const dest = args[1];

  if ((source === 'running-config' || source === 'run') &&
      (dest === 'startup-config' || dest === 'start')) {
    state.configModified = false;
    return {
      output: `Destination filename [startup-config]?
Building configuration...
[OK]`,
      exitCode: 0,
    };
  }

  if ((source === 'startup-config' || source === 'start') &&
      (dest === 'running-config' || dest === 'run')) {
    return {
      output: `Destination filename [running-config]? `,
      exitCode: 0,
    };
  }

  return {
    output: `${source} -> ${dest}
[OK]`,
    exitCode: 0,
  };
}

/**
 * Execute erase command
 */
function executeErase(args: string[], config: CiscoConfig): CiscoCommandResult {
  if (args[0] === 'startup-config' || args[0] === 'start') {
    return {
      output: `Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]
[OK]
Erase of nvram: complete`,
      exitCode: 0,
    };
  }

  return { output: '', error: '% Incomplete command.', exitCode: 1 };
}

/**
 * Execute reload command
 */
function executeReload(args: string[], state: CiscoTerminalState): CiscoCommandResult {
  if (state.configModified) {
    return {
      output: `System configuration has been modified. Save? [yes/no]: `,
      exitCode: 0,
    };
  }

  return {
    output: `Proceed with reload? [confirm]

*Mar  1 00:00:00.000: %SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.`,
    exitCode: 0,
  };
}

/**
 * Execute clear command
 */
function executeClear(args: string[], config: CiscoConfig): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  switch (args[0]) {
    case 'arp-cache':
    case 'arp':
      config.arpTable = [];
      return { output: '', exitCode: 0 };

    case 'mac':
      if (args[1] === 'address-table') {
        config.macTable = [];
        return { output: '', exitCode: 0 };
      }
      break;

    case 'counters':
      // Clear interface counters
      for (const [, iface] of config.interfaces) {
        iface.inputPackets = 0;
        iface.outputPackets = 0;
        iface.inputErrors = 0;
        iface.outputErrors = 0;
        iface.collisions = 0;
      }
      return { output: 'Clear "show interface" counters on all interfaces [confirm]', exitCode: 0 };

    case 'ip':
      if (args[1] === 'ospf' && args[2] === 'process') {
        return { output: 'Reset OSPF process? [no]: yes', exitCode: 0 };
      }
      if (args[1] === 'route') {
        return { output: '', exitCode: 0 };
      }
      break;

    case 'line':
      return { output: ' [OK]', exitCode: 0 };

    case 'logging':
      return { output: '', exitCode: 0 };
  }

  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

/**
 * Execute debug command
 */
function executeDebug(args: string[], config: CiscoConfig): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  if (args[0] === 'all') {
    return {
      output: `This may severely impact network performance. Continue? (yes/[no]):
All possible debugging has been turned on`,
      exitCode: 0,
    };
  }

  return { output: `${args.join(' ')} debugging is on`, exitCode: 0 };
}

/**
 * Execute undebug command
 */
function executeUndebug(args: string[], config: CiscoConfig): CiscoCommandResult {
  if (args.length === 0 || args[0] === 'all') {
    return { output: 'All possible debugging has been turned off', exitCode: 0 };
  }

  return { output: `${args.join(' ')} debugging is off`, exitCode: 0 };
}

/**
 * Execute terminal command
 */
function executeTerminal(args: string[], state: CiscoTerminalState): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  if (args[0] === 'length') {
    state.terminalLength = parseInt(args[1]) || 24;
    return { output: '', exitCode: 0 };
  }

  if (args[0] === 'width') {
    state.terminalWidth = parseInt(args[1]) || 80;
    return { output: '', exitCode: 0 };
  }

  if (args[0] === 'monitor') {
    return { output: '', exitCode: 0 };
  }

  if (args[0] === 'no' && args[1] === 'monitor') {
    return { output: '', exitCode: 0 };
  }

  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

/**
 * Execute telnet command
 */
function executeTelnet(args: string[]): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const target = args[0];
  const port = args[1] || '23';

  return {
    output: `Trying ${target}, ${port} ...
% Connection refused by remote host`,
    exitCode: 1,
  };
}

/**
 * Execute SSH command
 */
function executeSSH(args: string[]): CiscoCommandResult {
  if (args.length === 0) {
    return {
      output: `Usage: ssh [-l user] [-v version] [-c des|3des] [-o number_of_password_prompts]
         [-p port] host [command]`,
      exitCode: 0,
    };
  }

  const target = args.find(a => !a.startsWith('-')) || args[args.length - 1];

  return {
    output: `Trying ${target} ...
% Connection refused by remote host`,
    exitCode: 1,
  };
}

/**
 * Execute clock command
 */
function executeClock(args: string[]): CiscoCommandResult {
  if (args[0] === 'set') {
    // clock set hh:mm:ss day month year
    return { output: '', exitCode: 0 };
  }

  return { output: '', error: '% Incomplete command.', exitCode: 1 };
}

/**
 * Execute delete command
 */
function executeDelete(args: string[]): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  return { output: `Delete filename [${args[0]}]? \nDelete flash:/${args[0]}? [confirm]`, exitCode: 0 };
}

/**
 * Execute dir command
 */
function executeDir(args: string[]): CiscoCommandResult {
  return {
    output: `Directory of flash:/

    1  -rw-     123456   Mar  1 2024 12:00:00 +00:00  c2960-lanbasek9-mz.150-2.SE11.bin
    2  -rw-       2048   Mar  1 2024 12:00:00 +00:00  config.text
    3  -rw-       1024   Mar  1 2024 12:00:00 +00:00  vlan.dat

65536000 bytes total (65400000 bytes free)`,
    exitCode: 0,
  };
}

/**
 * Execute more command
 */
function executeMore(args: string[]): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  return { output: `% Error opening ${args[0]} (No such file or directory)`, exitCode: 1 };
}

/**
 * Execute verify command
 */
function executeVerify(args: string[]): CiscoCommandResult {
  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  return {
    output: `Verifying file integrity of ${args[0]}......Done!
Embedded Hash   MD5: ABCD1234ABCD1234ABCD1234ABCD1234
Computed Hash   MD5: ABCD1234ABCD1234ABCD1234ABCD1234
CCO Hash        MD5: ABCD1234ABCD1234ABCD1234ABCD1234

Signature Verified`,
    exitCode: 0,
  };
}

/**
 * Execute limited show commands for user mode
 */
function executeLimitedShow(
  args: string[],
  state: CiscoTerminalState,
  config: CiscoConfig,
  bootTime: Date
): CiscoCommandResult {
  const allowedShowCommands = ['version', 'clock', 'history', 'users', 'flash', 'flash:'];

  if (args.length === 0) {
    return { output: '', error: '% Incomplete command.', exitCode: 1 };
  }

  const subCommand = args[0].toLowerCase();

  if (allowedShowCommands.includes(subCommand)) {
    return executeShowCommand(args, state, config, bootTime);
  }

  return { output: '', error: '% Invalid input detected', exitCode: 1 };
}

/**
 * Get parent mode for exit command
 */
function getParentMode(mode: CiscoMode): CiscoMode {
  switch (mode) {
    case 'interface':
    case 'subinterface':
    case 'line':
    case 'router':
    case 'vlan':
    case 'dhcp':
    case 'acl':
    case 'route-map':
      return 'global-config';
    case 'global-config':
      return 'privileged';
    case 'privileged':
      return 'user';
    default:
      return 'user';
  }
}

/**
 * Get context-sensitive help
 */
function getContextHelp(state: CiscoTerminalState, config: CiscoConfig): CiscoCommandResult {
  switch (state.mode) {
    case 'user':
      return getUserHelp();
    case 'privileged':
      return getPrivilegedHelp();
    default:
      return getConfigHelp(state.mode);
  }
}

/**
 * Get partial command help
 */
function getPartialHelp(partial: string, state: CiscoTerminalState, config: CiscoConfig): CiscoCommandResult {
  // Find matching commands
  const commands = state.mode === 'user'
    ? getUserCommands()
    : state.mode === 'privileged'
    ? getPrivilegedCommands()
    : getConfigCommands(state.mode);

  const matches = commands.filter(cmd => cmd.startsWith(partial.toLowerCase()));

  if (matches.length === 0) {
    return { output: '% Unrecognized command', exitCode: 1 };
  }

  const help = matches.map(cmd => `  ${cmd}`).join('\n');
  return { output: help, exitCode: 0 };
}

/**
 * User mode help
 */
function getUserHelp(): CiscoCommandResult {
  return {
    output: `Exec commands:
  connect     Open a terminal connection
  disable     Turn off privileged commands
  enable      Turn on privileged commands
  exit        Exit from the EXEC
  logout      Exit from the EXEC
  ping        Send echo messages
  quit        Exit from the EXEC
  show        Show running system information
  ssh         Open a secure shell client connection
  telnet      Open a telnet connection
  terminal    Set terminal line parameters
  traceroute  Trace route to destination`,
    exitCode: 0,
  };
}

/**
 * Privileged mode help
 */
function getPrivilegedHelp(): CiscoCommandResult {
  return {
    output: `Exec commands:
  clear       Reset functions
  clock       Manage the system clock
  configure   Enter configuration mode
  copy        Copy from one file to another
  debug       Debugging functions
  delete      Delete a file
  dir         List files on a filesystem
  disable     Turn off privileged commands
  erase       Erase a filesystem
  exit        Exit from the EXEC
  logout      Exit from the EXEC
  more        Display the contents of a file
  ping        Send echo messages
  reload      Halt and perform a cold restart
  show        Show running system information
  ssh         Open a secure shell client connection
  telnet      Open a telnet connection
  terminal    Set terminal line parameters
  traceroute  Trace route to destination
  undebug     Disable debugging functions
  verify      Verify a file
  write       Write running configuration to memory`,
    exitCode: 0,
  };
}

/**
 * Config mode help
 */
function getConfigHelp(mode: CiscoMode): CiscoCommandResult {
  const commonHelp = `
  do          Execute an EXEC-level command
  end         Exit from configure mode
  exit        Exit from current mode`;

  switch (mode) {
    case 'global-config':
      return {
        output: `Configure commands:
  access-list       Add an access list entry
  banner            Define a login banner
  cdp               Global CDP configuration subcommands
  enable            Modify enable password parameters
  end               Exit from configure mode
  exit              Exit from configure mode
  hostname          Set system's network name
  interface         Select an interface to configure
  ip                Global IP configuration subcommands
  line              Configure a terminal line
  lldp              Global LLDP configuration subcommands
  logging           Modify message logging facilities
  ntp               Configure NTP
  router            Enable a routing process
  service           Modify use of network based services
  snmp-server       Modify SNMP engine parameters
  spanning-tree     Spanning Tree Subsystem
  username          Establish User Name Authentication
  vlan              VLAN commands
  vtp               Configure global VTP state${commonHelp}`,
        exitCode: 0,
      };

    case 'interface':
    case 'subinterface':
      return {
        output: `Interface configuration commands:
  bandwidth         Set bandwidth informational parameter
  description       Interface specific description
  duplex            Configure duplex operation
  encapsulation     Set encapsulation type for an interface
  ip                Interface Internet Protocol config commands
  mtu               Set the interface Maximum Transmission Unit (MTU)
  no                Negate a command or set its defaults
  shutdown          Shutdown the selected interface
  spanning-tree     Spanning Tree Subsystem
  speed             Configure speed operation
  switchport        Set switching mode characteristics${commonHelp}`,
        exitCode: 0,
      };

    case 'line':
      return {
        output: `Line configuration commands:
  exec-timeout      Set the EXEC timeout
  login             Enable password checking
  logging           Modify message logging facilities
  no                Negate a command or set its defaults
  password          Set a password
  transport         Define transport protocols for line${commonHelp}`,
        exitCode: 0,
      };

    case 'router':
      return {
        output: `Router configuration commands:
  auto-summary      Enable automatic network number summarization
  default-information   Control distribution of default information
  network           Enable routing on an IP network
  no                Negate a command or set its defaults
  passive-interface Suppress routing updates on an interface
  redistribute      Redistribute information from another routing protocol
  router-id         Router ID for this OSPF process
  version           Set routing protocol version${commonHelp}`,
        exitCode: 0,
      };

    case 'vlan':
      return {
        output: `VLAN configuration commands:
  mtu               VLAN Maximum Transmission Unit
  name              Ascii name of the VLAN
  no                Negate a command or set its defaults
  shutdown          Shutdown VLAN switching
  state             Operational state of the VLAN${commonHelp}`,
        exitCode: 0,
      };

    default:
      return {
        output: `Configuration commands:${commonHelp}`,
        exitCode: 0,
      };
  }
}

/**
 * Get list of user mode commands
 */
function getUserCommands(): string[] {
  return [
    'connect', 'disable', 'enable', 'exit', 'logout',
    'ping', 'quit', 'show', 'ssh', 'telnet', 'terminal', 'traceroute'
  ];
}

/**
 * Get list of privileged mode commands
 */
function getPrivilegedCommands(): string[] {
  return [
    'clear', 'clock', 'configure', 'copy', 'debug', 'delete',
    'dir', 'disable', 'erase', 'exit', 'logout', 'more',
    'ping', 'reload', 'show', 'ssh', 'telnet', 'terminal',
    'traceroute', 'undebug', 'verify', 'write'
  ];
}

/**
 * Get list of config mode commands
 */
function getConfigCommands(mode: CiscoMode): string[] {
  const common = ['do', 'end', 'exit', 'no'];

  switch (mode) {
    case 'global-config':
      return [
        ...common, 'access-list', 'banner', 'cdp', 'enable', 'hostname',
        'interface', 'ip', 'line', 'lldp', 'logging', 'ntp', 'router',
        'service', 'snmp-server', 'spanning-tree', 'username', 'vlan', 'vtp'
      ];
    case 'interface':
    case 'subinterface':
      return [
        ...common, 'bandwidth', 'description', 'duplex', 'encapsulation',
        'ip', 'mtu', 'shutdown', 'spanning-tree', 'speed', 'switchport'
      ];
    case 'line':
      return [...common, 'exec-timeout', 'login', 'logging', 'password', 'transport'];
    case 'router':
      return [
        ...common, 'auto-summary', 'default-information', 'network',
        'passive-interface', 'redistribute', 'router-id', 'version'
      ];
    case 'vlan':
      return [...common, 'mtu', 'name', 'shutdown', 'state'];
    default:
      return common;
  }
}

/**
 * Expand abbreviated command to full command
 */
function expandCommand(abbrev: string, commands: string[]): string | null {
  const matches = commands.filter(cmd => cmd.startsWith(abbrev));
  if (matches.length === 1) {
    return matches[0];
  }
  return null;
}

// Export command registry and functions
export {
  executeShowCommand,
  executeConfigCommand,
  executePing,
  executeTraceroute,
};
