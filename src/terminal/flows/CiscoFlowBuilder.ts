/**
 * CiscoFlowBuilder — Declarative flow definitions for Cisco IOS interactive prompts.
 *
 * Cisco IOS interactive scenarios:
 *   - enable (password prompt to enter privileged mode)
 *   - copy running-config startup-config (Destination filename [startup-config]?)
 *   - reload (Proceed with reload? [confirm])
 *   - erase startup-config (Erasing the nvram filesystem... Continue? [confirm])
 *   - initial setup dialog (Would you like to enter the initial configuration dialog?)
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

  /** Copy running-config startup-config: ask filename, then execute */
  static copyRunningConfig(): InteractiveStep[] {
    return [
      {
        type: 'text',
        prompt: 'Destination filename [startup-config]? ',
        allowEmpty: true,
        storeAs: 'destination_filename',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          const exec = ctx.executeCommand ?? (async (cmd: string) => ctx.device.executeCommand(cmd));
          await exec('write memory');
        },
      },
      {
        type: 'output',
        outputLines: ['Building configuration...', '', '[OK]'],
      },
    ];
  }

  /** Reload: confirm, then execute reload on device */
  static reloadConfirmation(): InteractiveStep[] {
    return [
      {
        type: 'confirmation',
        prompt: 'Proceed with reload? [confirm]',
        defaultAnswer: 'yes',
        storeAs: 'reload_confirmed',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          const exec = ctx.executeCommand ?? (async (cmd: string) => ctx.device.executeCommand(cmd));
          await exec('reload');
        },
      },
    ];
  }

  /** Erase startup-config: confirm, then show result */
  static eraseStartupConfig(): InteractiveStep[] {
    return [
      {
        type: 'confirmation',
        prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
        defaultAnswer: 'yes',
        storeAs: 'erase_confirmed',
      },
      {
        type: 'output',
        outputLines: ['[OK]', 'Erase of nvram: complete'],
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
          return (answer === 'yes' || answer === 'y') ? 2 : 999;
        },
      },
    ];
  }
}
