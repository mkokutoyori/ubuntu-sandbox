import { HUAWEI_VRP_MODES } from '../../../network/devices/shells/CLIStateMachine';
import { HUAWEI_VRP_PROMPTS } from '../../../network/devices/shells/PromptBuilder';
import type { ModeHierarchy } from '../../../network/devices/shells/CLIStateMachine';
import type { PromptMap } from '../../../network/devices/shells/PromptBuilder';

export const VRP_MODES: ModeHierarchy = HUAWEI_VRP_MODES;
export const VRP_PROMPTS: PromptMap = HUAWEI_VRP_PROMPTS;
export const VRP_TOP_LEVEL = 'user';
export const VRP_EXEC_LEVEL = 'system';

export const VRP_SWITCH_MODES: ModeHierarchy = {
  'user':               { parent: null },
  'system':             { parent: 'user' },
  'interface':          { parent: 'system', clearOnExit: ['selectedInterface'] },
  'vlan':               { parent: 'system', clearOnExit: ['selectedVlan'] },
  'mst-region':         { parent: 'system' },
  'port-group':         { parent: 'system', clearOnExit: ['portGroupName'] },
  'aaa':                { parent: 'system' },
  'user-interface':     { parent: 'system', clearOnExit: ['uiLabel'] },
  'acl':                { parent: 'system', clearOnExit: ['selectedAcl'] },
  'dhcp-pool':          { parent: 'system', clearOnExit: ['selectedPool'] },
  'traffic-classifier': { parent: 'system', clearOnExit: ['selectedMqcName'] },
  'traffic-behavior':   { parent: 'system', clearOnExit: ['selectedMqcName'] },
  'traffic-policy':     { parent: 'system', clearOnExit: ['selectedMqcName'] },
};
