import type { ModeHierarchy } from '../../../network/devices/shells/CLIStateMachine';
import type { PromptMap } from '../../../network/devices/shells/PromptBuilder';

export const ASA_MODES: ModeHierarchy = Object.freeze({
  exec: { parent: null },
  privileged: { parent: 'exec' },
  config: { parent: 'privileged' },
  'config-if': { parent: 'config', clearOnExit: ['selectedInterface'] },
  'config-object': { parent: 'config', clearOnExit: ['selectedObject'] },
  'config-group': { parent: 'config', clearOnExit: ['selectedGroup'] },
});

export const ASA_PROMPTS: PromptMap = Object.freeze({
  exec: '{host}>',
  privileged: '{host}#',
  config: '{host}(config)#',
  'config-if': '{host}(config-if)#',
  'config-object': '{host}(config-network-object)#',
  'config-group': '{host}(config-network-object-group)#',
});

export const ASA_TOP_LEVEL = 'exec';
export const ASA_EXEC_LEVEL = 'privileged';
