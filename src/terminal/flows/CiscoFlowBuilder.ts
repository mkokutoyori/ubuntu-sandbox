/**
 * CiscoFlowBuilder — Declarative flow definitions for Cisco IOS interactive prompts.
 *
 * Cisco IOS interactive scenarios:
 *   - enable (password prompt to enter privileged mode)
 *   - initial setup dialog (Would you like to enter the initial configuration dialog?)
 *   - copy running-config (Destination filename [startup-config]?)
 *   - reload (Proceed with reload? [confirm])
 *   - erase startup-config (Confirm erase? [confirm])
 */

import type { InteractiveStep, FlowContext } from '../core/types';

export class CiscoFlowBuilder {

  /** Enable mode password prompt */
  static enablePassword(): InteractiveStep[] {
    return [
      {
        type: 'password',
        prompt: 'Password:',
        mask: 'hidden',
        storeAs: 'enable_password',
        validation: (pwd: string, ctx: FlowContext) => {
          const device = ctx.device as any;
          const valid = typeof device.checkEnablePassword === 'function'
            ? device.checkEnablePassword(pwd)
            : true;
          return {
            valid,
            errorMessage: valid ? undefined : '% Bad secrets',
            maxRetries: 2,
          };
        },
      },
    ];
  }

  /** Copy running-config startup-config confirmation */
  static copyRunningConfig(): InteractiveStep[] {
    return [
      {
        type: 'text',
        prompt: 'Destination filename [startup-config]? ',
        allowEmpty: true,
        storeAs: 'destination_filename',
      },
      {
        type: 'output',
        outputLines: ['[OK]'],
      },
    ];
  }

  /** Reload confirmation */
  static reloadConfirmation(): InteractiveStep[] {
    return [
      {
        type: 'confirmation',
        prompt: 'Proceed with reload? [confirm]',
        defaultAnswer: 'yes',
        storeAs: 'reload_confirmed',
      },
    ];
  }

  /** Erase startup-config confirmation */
  static eraseStartupConfig(): InteractiveStep[] {
    return [
      {
        type: 'confirmation',
        prompt: '[OK]\nErase of nvram: complete',
        defaultAnswer: 'yes',
        storeAs: 'erase_confirmed',
      },
    ];
  }

  /** Initial configuration dialog */
  static initialSetupDialog(): InteractiveStep[] {
    return [
      {
        type: 'confirmation',
        prompt: 'Would you like to enter the initial configuration dialog? [yes/no]: ',
        defaultAnswer: 'no',
        storeAs: 'wants_setup',
      },
      {
        type: 'branch',
        predicate: (ctx: FlowContext) => {
          const answer = ctx.values.get('wants_setup')?.toLowerCase();
          // If no, skip to end (index beyond steps length)
          return (answer === 'yes' || answer === 'y') ? 2 : 999;
        },
      },
      // Future: setup wizard steps would go here
    ];
  }
}
