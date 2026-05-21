/**
 * LinuxFlowBuilder — Declarative flow definitions for Linux interactive commands.
 *
 * Each static method returns an InteractiveStep[] that the InteractiveFlowEngine
 * processes. This replaces the monolithic buildInteractiveSteps() in
 * LinuxTerminalSession with composable, testable flow definitions.
 *
 * Supported flows:
 *   - sudo <command>       (password prompt → execute)
 *   - sudo passwd <user>   (sudo password → new password → retype → set)
 *   - sudo adduser <user>  (sudo password → create → password → GECOS → confirm)
 *   - su [user]            (password prompt → switch user)
 *   - passwd               (current password → new → retype → set)
 *   - passwd <user> (root) (new → retype → set)
 *   - adduser <user> (root)(create → password → GECOS → confirm)
 *
 * Faithfulness note: `adduser` is the interactive Debian/Ubuntu front-end —
 * it is the command that prompts for a password and the GECOS finger
 * fields. The low-level `useradd` command is intentionally given NO flow:
 * on real equipment it is non-interactive and simply creates the account,
 * so it falls through to plain (silent) execution.
 */

import type { InteractiveStep, FlowContext } from '../core/types';
import { tokenize } from '@/network/devices/linux/LinuxShellParser';
import { parseAdduserArgs } from '@/network/devices/linux/iam/adduserOptions';

// ─── Constants ──────────────────────────────────────────────────────

const MAX_SUDO_ATTEMPTS = 3;
const MAX_SU_ATTEMPTS = 3;

// ─── Execute-and-display helper ─────────────────────────────────────

/** Build an execute step that runs a command on the device and displays output */
function executeCommandStep(command: string): InteractiveStep {
  return {
    type: 'execute',
    action: async (ctx: FlowContext) => {
      const exec = ctx.executeCommand ?? (async (cmd: string) => ctx.device.executeCommand(cmd));
      const result = await exec(command);
      if (result) {
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
          ctx.onClearScreen?.();
        } else {
          ctx.onOutput?.(result);
        }
      }
    },
  };
}

// ─── Reusable step fragments ────────────────────────────────────────

/** Build a sudo password verification step */
function sudoPasswordStep(currentUser: string): InteractiveStep {
  return {
    type: 'password',
    prompt: `[sudo] password for ${currentUser}:`,
    mask: 'hidden',
    storeAs: 'sudo_password',
    validation: (pwd: string, ctx: FlowContext) => {
      const valid = ctx.device.checkPassword(ctx.currentUser, pwd);
      return {
        valid,
        errorMessage: valid ? undefined : 'Sorry, try again.',
        maxRetries: MAX_SUDO_ATTEMPTS - 1,
      };
    },
  };
}

/** Build a "su" password verification step for target user */
function suPasswordStep(targetUser: string): InteractiveStep {
  return {
    type: 'password',
    prompt: 'Password:',
    mask: 'hidden',
    storeAs: 'su_password',
    validation: (pwd: string, ctx: FlowContext) => {
      const valid = ctx.device.checkPassword(targetUser, pwd);
      return {
        valid,
        errorMessage: valid ? undefined : 'su: Authentication failure',
        maxRetries: MAX_SU_ATTEMPTS - 1,
      };
    },
  };
}

/** "Current password" step for non-root passwd (own password change) */
function currentPasswordStep(): InteractiveStep {
  return {
    type: 'password',
    prompt: 'Current password:',
    mask: 'hidden',
    storeAs: 'current_password',
    validation: (pwd: string, ctx: FlowContext) => {
      const valid = ctx.device.checkPassword(ctx.currentUser, pwd);
      return {
        valid,
        errorMessage: valid ? undefined : 'passwd: Authentication token manipulation error\npasswd: password unchanged',
        maxRetries: 0,
      };
    },
  };
}

/** "New password" + "Retype" steps */
function newPasswordSteps(): InteractiveStep[] {
  return [
    {
      type: 'password',
      prompt: 'New password:',
      mask: 'hidden',
      storeAs: 'new_password',
      validation: (pwd: string) => ({
        valid: pwd.length >= 1,
        errorMessage: 'No password supplied',
        maxRetries: 0,
      }),
    },
    {
      type: 'password',
      prompt: 'Retype new password:',
      mask: 'hidden',
      storeAs: 'confirm_password',
      validation: (pwd: string, ctx: FlowContext) => ({
        valid: pwd === ctx.values.get('new_password'),
        errorMessage: 'Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged',
        maxRetries: 0,
      }),
    },
  ];
}

/** Set password execute step */
function setPasswordStep(targetUserKey: string): InteractiveStep {
  return {
    type: 'execute',
    action: async (ctx: FlowContext) => {
      const targetUser = ctx.metadata.get(targetUserKey) as string ?? ctx.currentUser;
      const password = ctx.values.get('new_password');
      if (password) {
        ctx.device.setUserPassword(targetUser, password);
      }
    },
  };
}

/** GECOS (user info) prompts: Full Name, Room, Work Phone, Home Phone, Other */
function gecosSteps(targetUser: string): InteractiveStep[] {
  return [
    {
      type: 'output',
      outputLines: [
        `Changing the user information for ${targetUser}`,
        'Enter the new value, or press ENTER for the default',
      ],
    },
    { type: 'text', prompt: '\tFull Name []: ', allowEmpty: true, storeAs: 'gecos_fullName' },
    { type: 'text', prompt: '\tRoom Number []: ', allowEmpty: true, storeAs: 'gecos_room' },
    { type: 'text', prompt: '\tWork Phone []: ', allowEmpty: true, storeAs: 'gecos_workPhone' },
    { type: 'text', prompt: '\tHome Phone []: ', allowEmpty: true, storeAs: 'gecos_homePhone' },
    { type: 'text', prompt: '\tOther []: ', allowEmpty: true, storeAs: 'gecos_other' },
    {
      type: 'confirmation',
      prompt: 'Is the information correct? [Y/n] ',
      defaultAnswer: 'yes',
      storeAs: 'gecos_confirmed',
      validation: (val: string) => {
        const answer = val.trim().toLowerCase();
        if (answer === 'n' || answer === 'no') {
          return { valid: false, errorMessage: 'Aborted.', maxRetries: 0 };
        }
        return { valid: true };
      },
    },
    {
      type: 'execute',
      action: async (ctx: FlowContext) => {
        if ('setUserGecos' in ctx.device) {
          (ctx.device as any).setUserGecos(
            targetUser,
            ctx.values.get('gecos_fullName') ?? '',
            ctx.values.get('gecos_room') ?? '',
            ctx.values.get('gecos_workPhone') ?? '',
            ctx.values.get('gecos_homePhone') ?? '',
            ctx.values.get('gecos_other') ?? '',
          );
        }
      },
    },
  ];
}

// ─── Public API: Flow Builders ──────────────────────────────────────

export class LinuxFlowBuilder {

  /**
   * Determine if a command requires an interactive flow.
   * Returns the steps if so, null otherwise.
   */
  static build(command: string, currentUser: string, currentUid: number, device: any): InteractiveStep[] | null {
    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    const isRoot = currentUid === 0;

    if (parts[0] === 'sudo' && !isRoot) {
      return LinuxFlowBuilder.buildSudoFlow(parts, trimmed, currentUser, device);
    }

    if (parts[0] === 'su' && !isRoot) {
      return LinuxFlowBuilder.buildSuFlow(parts);
    }

    if (parts[0] === 'passwd') {
      return LinuxFlowBuilder.buildPasswdFlow(parts, currentUser, isRoot);
    }

    if (parts[0] === 'adduser' && parts.length >= 2 && isRoot) {
      return LinuxFlowBuilder.buildRootAdduserFlow(trimmed, device);
    }

    // Note: `useradd` is intentionally absent — it is non-interactive on
    // real systems and must execute silently. `adduser` is the wrapper
    // that prompts.

    return null;
  }

  /**
   * Shared account-creation tail: the password capture and GECOS finger
   * prompts that follow the `adduser` create step. Either half can be
   * omitted when a flag already supplied that information.
   */
  private static userCreationTail(
    targetUser: string,
    withPassword: boolean,
    withGecos: boolean,
  ): InteractiveStep[] {
    const passwordSteps: InteractiveStep[] = withPassword ? [
      ...newPasswordSteps(),
      {
        type: 'execute',
        action: async (ctx) => {
          ctx.device.setUserPassword(targetUser, ctx.values.get('new_password')!);
        },
      },
      { type: 'output', outputLines: ['passwd: password updated successfully'] },
    ] : [];

    const chfnSteps: InteractiveStep[] = withGecos ? gecosSteps(targetUser) : [];

    return [...passwordSteps, ...chfnSteps];
  }

  /** Build sudo flow: authenticate → execute sub-command (with special cases for passwd/adduser) */
  private static buildSudoFlow(
    parts: string[],
    fullCommand: string,
    currentUser: string,
    device: any,
  ): InteractiveStep[] | null {
    // Check sudoers
    if (!device.canSudo()) return null;

    const subParts = parts.slice(1);
    const subCmd = subParts[0];

    // No sub-command or sudo -l → no interactive steps
    if (!subCmd || subCmd === '-l') return null;

    const sudoStep = sudoPasswordStep(currentUser);

    // sudo passwd with flags (e.g., -l, -u, -S)
    if (subCmd === 'passwd' && subParts.length >= 2 && subParts[1].startsWith('-')) {
      return [
        sudoStep,
        executeCommandStep(fullCommand),
      ];
    }

    // sudo passwd <user> — change another user's password
    if (subCmd === 'passwd' && subParts.length >= 2 && !subParts[1].startsWith('-')) {
      const targetUser = subParts[subParts.length - 1];
      return [
        sudoStep,
        ...newPasswordSteps(),
        {
          type: 'execute',
          action: async (ctx) => {
            ctx.device.setUserPassword(targetUser, ctx.values.get('new_password')!);
          },
        },
        { type: 'output', outputLines: ['passwd: password updated successfully'] },
      ];
    }

    // sudo adduser <user>
    if (subCmd === 'adduser') {
      const req = parseAdduserArgs(tokenize(fullCommand).slice(2));
      const interactive = req.mode === 'create-user'
        && !!req.name
        && !req.system
        && !(typeof device.userExists === 'function' && device.userExists(req.name));

      if (!interactive) {
        // create-group / add-to-group / system / existing user → run silently
        // after authenticating; the command surfaces its own output.
        return [sudoStep, executeCommandStep(fullCommand)];
      }

      const withPassword = !req.disabledPassword;
      const withGecos = req.gecos === undefined;
      return [
        sudoStep,
        // Execute adduser command to create the user first.
        executeCommandStep(fullCommand),
        ...LinuxFlowBuilder.userCreationTail(req.name, withPassword, withGecos),
      ];
    }

    // sudo useradd — non-interactive on real systems: authenticate, then
    // let `useradd` execute silently via the generic sudo path below.

    // sudo su
    if (subCmd === 'su') {
      return [
        sudoStep,
        executeCommandStep(fullCommand),
      ];
    }

    // Generic sudo <command>
    return [
      sudoStep,
      executeCommandStep(fullCommand),
    ];
  }

  /** Build su flow: authenticate as target user → switch */
  private static buildSuFlow(parts: string[]): InteractiveStep[] {
    let targetUser = 'root';
    for (const p of parts.slice(1)) {
      if (p !== '-' && p !== '-l' && p !== '--login' && !p.startsWith('-')) {
        targetUser = p;
      }
    }

    return [
      suPasswordStep(targetUser),
      executeCommandStep(parts.join(' ')),
    ];
  }

  /** Build passwd flow (no sudo prefix) */
  private static buildPasswdFlow(
    parts: string[],
    currentUser: string,
    isRoot: boolean,
  ): InteractiveStep[] | null {
    // passwd (no args) — change own password
    if (parts.length === 1) {
      if (isRoot) {
        // Root changes own password without current password
        return [
          ...newPasswordSteps(),
          setPasswordStep('self'),
          { type: 'output', outputLines: ['passwd: password updated successfully'] },
        ];
      }
      return [
        { type: 'output', outputLines: [`Changing password for ${currentUser}.`] },
        currentPasswordStep(),
        ...newPasswordSteps(),
        setPasswordStep('self'),
        { type: 'output', outputLines: ['passwd: password updated successfully'] },
      ];
    }

    // passwd <user> as root — change another user's password
    if (parts.length >= 2 && !parts[1].startsWith('-') && isRoot) {
      const targetUser = parts[parts.length - 1];
      return [
        ...newPasswordSteps(),
        {
          type: 'execute',
          action: async (ctx) => {
            ctx.device.setUserPassword(targetUser, ctx.values.get('new_password')!);
          },
        },
        { type: 'output', outputLines: ['passwd: password updated successfully'] },
      ];
    }

    return null;
  }

  /**
   * Build the `adduser <user>` flow when already root (no sudo needed).
   *
   * Only a plain user creation is interactive. Returns null — deferring to
   * silent execution — for the non-creating overloads (`adduser <user>
   * <group>`, `adduser --group`), for system accounts (`--system`), for an
   * already-existing account, and when both `--disabled-password` and
   * `--gecos` have removed every prompt.
   */
  private static buildRootAdduserFlow(
    fullCommand: string,
    device: any,
  ): InteractiveStep[] | null {
    const req = parseAdduserArgs(tokenize(fullCommand).slice(1));
    if (req.mode !== 'create-user' || !req.name || req.system) return null;
    if (typeof device.userExists === 'function' && device.userExists(req.name)) {
      return null;
    }

    const withPassword = !req.disabledPassword;
    const withGecos = req.gecos === undefined;
    if (!withPassword && !withGecos) return null;

    return [
      // Execute adduser to create the user first.
      executeCommandStep(fullCommand),
      ...LinuxFlowBuilder.userCreationTail(req.name, withPassword, withGecos),
    ];
  }
}
