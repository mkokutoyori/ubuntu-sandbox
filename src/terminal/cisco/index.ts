/**
 * Cisco IOS Terminal
 * Main export file
 */

// Types
export * from './types';

// State management
export {
  createDefaultRouterConfig,
  createDefaultSwitchConfig,
  createDefaultTerminalState,
  getPrompt,
  formatUptime,
  generateRunningConfig,
  generateStartupConfig,
} from './state';

// Commands
export {
  executeCiscoCommand,
  parseCommand,
  executeShowCommand,
  executeConfigCommand,
} from './commands';
