/**
 * Huawei VRP command-owned interactive flows (IoC).
 *
 * Declares the interactive dialogue of `save`, `reset saved-configuration`
 * and `reboot` for BOTH VRP shells (router and switch). The plans' run
 * steps execute the REAL device commands — the terminal renders prompts
 * and forwards answers, nothing more.
 */

import type {
  CommandInteractionPlan,
  InteractionValidation,
} from '@/shell/interaction/CommandInteraction';

function cancelOnNo(message: string) {
  return (value: string): InteractionValidation => {
    const answer = value.trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      return { valid: false, errorMessage: message, maxRetries: 0 };
    }
    return { valid: true };
  };
}

function savePlan(): CommandInteractionPlan {
  return {
    steps: [
      {
        kind: 'output',
        lines: [
          'Warning: The current configuration will be written to the device.',
          'Are you sure to continue? [Y/N]:',
        ],
      },
      {
        kind: 'confirmation',
        prompt: '',
        defaultAnswer: 'yes',
        storeAs: 'save_confirmed',
        validate: cancelOnNo('Info: The operation is canceled.'),
      },
      // The device `save` performs the real capture; its inline text is
      // dropped because this plan renders its own dialogue.
      { kind: 'run', run: async (rt) => { await rt.exec('save'); } },
      {
        kind: 'output',
        lines: ['Now saving the current configuration to the slot 0...', '[OK]'],
      },
    ],
  };
}

function resetSavedConfigurationPlan(): CommandInteractionPlan {
  return {
    steps: [
      {
        kind: 'output',
        lines: [
          'Warning: The action will delete the saved configuration on the device.',
          'The configuration will be erased to reconfigure. Continue? [Y/N]:',
        ],
      },
      {
        kind: 'confirmation',
        prompt: '',
        defaultAnswer: 'no',
        storeAs: 'reset_confirmed',
        validate: cancelOnNo('Info: User cancelled the operation.'),
      },
      { kind: 'run', run: async (rt) => { await rt.exec('reset saved-configuration'); } },
    ],
  };
}

function rebootPlan(): CommandInteractionPlan {
  return {
    steps: [
      {
        kind: 'output',
        lines: ['Info: The system will reboot.', 'Continue? [Y/N]:'],
      },
      {
        kind: 'confirmation',
        prompt: '',
        defaultAnswer: 'no',
        storeAs: 'reboot_confirmed',
        validate: cancelOnNo('Info: The reboot command is canceled.'),
      },
    ],
  };
}

/**
 * VRP keyword matching: exact command word, or an unambiguous prefix of at
 * least two characters ("sav", "rebo"). Kept conservative on purpose — a
 * one-letter token could shadow unrelated commands.
 */
function matchesKeyword(token: string, keyword: string): boolean {
  const t = token.toLowerCase();
  return t.length >= 2 && keyword.startsWith(t);
}

export function huaweiInteractionPlanFor(commandLine: string): CommandInteractionPlan | null {
  const toks = commandLine.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return null;

  if (toks.length === 1 && toks[0].toLowerCase() === 'save') return savePlan();
  if (toks.length === 1 && toks[0].toLowerCase() === 'reboot') return rebootPlan();
  if (toks.length === 2 && toks[0].toLowerCase() === 'reset' && matchesKeyword(toks[1], 'saved-configuration')) {
    return resetSavedConfigurationPlan();
  }
  return null;
}
