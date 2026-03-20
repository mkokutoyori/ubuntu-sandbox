/**
 * HuaweiFlowBuilder — Declarative flow definitions for Huawei VRP interactive prompts.
 *
 * Huawei VRP interactive scenarios:
 *   - super (password prompt for entering system view with privileges)
 *   - save (Save current configuration? [Y/N])
 *   - reset saved-configuration (Warning: clear configuration? [Y/N])
 *   - reboot (Confirm reboot? [Y/N])
 */

import type { InteractiveStep, FlowContext } from '../core/types';

export class HuaweiFlowBuilder {

  /** Super user authentication (equivalent to Cisco 'enable') */
  static superPassword(): InteractiveStep[] {
    return [
      {
        type: 'password',
        prompt: 'Password:',
        mask: 'hidden',
        storeAs: 'super_password',
        validation: (pwd: string, ctx: FlowContext) => {
          const device = ctx.device as any;
          const valid = typeof device.checkEnablePassword === 'function'
            ? device.checkEnablePassword(pwd)
            : true;
          return {
            valid,
            errorMessage: valid ? undefined : 'Error: Failed to verify the super password.',
            maxRetries: 2,
          };
        },
      },
    ];
  }

  /** Save configuration prompt */
  static saveConfiguration(): InteractiveStep[] {
    return [
      {
        type: 'output',
        outputLines: [
          'Warning: The current configuration will be written to the device.',
          'Are you sure to continue? [Y/N]:',
        ],
      },
      {
        type: 'confirmation',
        prompt: '',
        defaultAnswer: 'yes',
        storeAs: 'save_confirmed',
      },
      {
        type: 'output',
        outputLines: ['Now saving the current configuration to the slot 0...', '[OK]'],
      },
    ];
  }

  /** Reset saved-configuration */
  static resetSavedConfiguration(): InteractiveStep[] {
    return [
      {
        type: 'output',
        outputLines: [
          'Warning: The action will delete the saved configuration on the device.',
          'The configuration will be erased to reconfigure. Continue? [Y/N]:',
        ],
      },
      {
        type: 'confirmation',
        prompt: '',
        defaultAnswer: 'no',
        storeAs: 'reset_confirmed',
        validation: (val: string) => {
          const answer = val.trim().toLowerCase();
          if (answer === 'n' || answer === 'no') {
            return { valid: false, errorMessage: 'Info: User cancelled the operation.', maxRetries: 0 };
          }
          return { valid: true };
        },
      },
    ];
  }

  /** Reboot confirmation */
  static rebootConfirmation(): InteractiveStep[] {
    return [
      {
        type: 'output',
        outputLines: [
          'Info: The system will reboot.',
          'Continue? [Y/N]:',
        ],
      },
      {
        type: 'confirmation',
        prompt: '',
        defaultAnswer: 'no',
        storeAs: 'reboot_confirmed',
      },
    ];
  }
}
