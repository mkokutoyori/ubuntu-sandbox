import { HUAWEI_VRP_MODES } from '../../../network/devices/shells/CLIStateMachine';
import { HUAWEI_VRP_PROMPTS } from '../../../network/devices/shells/PromptBuilder';
import type { ModeHierarchy } from '../../../network/devices/shells/CLIStateMachine';
import type { PromptMap } from '../../../network/devices/shells/PromptBuilder';

export const VRP_MODES: ModeHierarchy = HUAWEI_VRP_MODES;
export const VRP_PROMPTS: PromptMap = HUAWEI_VRP_PROMPTS;
export const VRP_TOP_LEVEL = 'user';
export const VRP_EXEC_LEVEL = 'system';
