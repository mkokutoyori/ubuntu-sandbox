/**
 * STUB FILE - will be rebuilt with TDD
 * Cisco terminal command execution and utilities
 */

import { CiscoMode, CiscoConfig, InterfaceConfig, RouteEntry } from './types';

export * from './types';

export interface CiscoCommandContext {
  mode: CiscoMode;
  runningConfig: CiscoConfig;
  startupConfig: CiscoConfig;
  configContext?: string;
}

export interface CiscoCommandResult {
  output: string;
  newMode?: CiscoMode;
  configContext?: string;
  isError?: boolean;
}

export function executeCiscoCommand(
  command: string,
  context: CiscoCommandContext
): CiscoCommandResult {
  const cmd = command.trim().toLowerCase();

  // Mode transitions
  if (cmd === 'enable') {
    return { output: '', newMode: 'privileged' };
  }
  if (cmd === 'configure terminal' || cmd === 'conf t') {
    return { output: 'Enter configuration commands, one per line.  End with CNTL/Z.', newMode: 'config' };
  }
  if (cmd === 'exit') {
    const modeMap: Record<CiscoMode, CiscoMode> = {
      'privileged': 'user',
      'config': 'privileged',
      'interface': 'config',
      'line': 'config',
      'router': 'config',
      'user': 'user'
    };
    return { output: '', newMode: modeMap[context.mode], configContext: undefined };
  }

  // Show commands
  if (cmd.startsWith('show')) {
    return { output: `STUB: Output for '${command}'` };
  }

  // Config commands
  if (cmd.startsWith('interface ')) {
    const ifName = command.substring('interface '.length);
    return {
      output: '',
      newMode: 'interface',
      configContext: ifName
    };
  }

  return { output: `STUB: Executed '${command}'` };
}

export function getCiscoPrompt(hostname: string, mode: CiscoMode, configContext?: string): string {
  switch (mode) {
    case 'user':
      return `${hostname}> `;
    case 'privileged':
      return `${hostname}# `;
    case 'config':
      return `${hostname}(config)# `;
    case 'interface':
      return `${hostname}(config-if)# `;
    case 'line':
      return `${hostname}(config-line)# `;
    case 'router':
      return `${hostname}(config-router)# `;
    default:
      return `${hostname}> `;
  }
}

export function initializeCiscoConfig(hostname: string): CiscoConfig {
  return {
    hostname,
    interfaces: {},
    routes: []
  };
}

export function createDefaultRouterConfig(hostname: string): CiscoConfig {
  return {
    hostname,
    interfaces: {
      'FastEthernet0/0': {
        name: 'FastEthernet0/0',
        status: 'down',
        protocol: 'down'
      },
      'FastEthernet0/1': {
        name: 'FastEthernet0/1',
        status: 'down',
        protocol: 'down'
      }
    },
    routes: []
  };
}

export function createDefaultSwitchConfig(hostname: string): CiscoConfig {
  return {
    hostname,
    interfaces: {
      'GigabitEthernet0/1': {
        name: 'GigabitEthernet0/1',
        status: 'down',
        protocol: 'down'
      },
      'GigabitEthernet0/2': {
        name: 'GigabitEthernet0/2',
        status: 'down',
        protocol: 'down'
      }
    },
    routes: [],
    vlans: {}
  };
}

export function createDefaultTerminalState(hostname: string): any {
  return {
    mode: 'user' as CiscoMode,
    output: [],
    commandHistory: [],
    historyIndex: 0,
    runningConfig: createDefaultRouterConfig(hostname),
    startupConfig: createDefaultRouterConfig(hostname)
  };
}

// Alias for compatibility
export const getPrompt = getCiscoPrompt;
