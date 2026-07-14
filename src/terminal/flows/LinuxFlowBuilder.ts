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

/** Like {@link executeCommandStep} but pipes the validated su password to
 *  su(1) on stdin, so the command-layer authentication succeeds. */
function suExecuteStep(command: string): InteractiveStep {
  return {
    type: 'execute',
    action: async (ctx: FlowContext) => {
      const pwd = (ctx.values.get('su_password') ?? '').replace(/'/g, "'\\''");
      const exec = ctx.executeCommand ?? (async (cmd: string) => ctx.device.executeCommand(cmd));
      const result = await exec(`printf '%s\\n' '${pwd}' | ${command}`);
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
      const valid = ctx.device.checkPassword?.(ctx.currentUser, pwd) ?? false;
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
      const valid = ctx.device.checkPassword?.(targetUser, pwd) ?? false;
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
      const valid = ctx.device.checkPassword?.(ctx.currentUser, pwd) ?? false;
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
        ctx.device.setUserPassword?.(targetUser, password);
      }
    },
  };
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

    // Root running `sudo <cmd>` is the same as `<cmd>` from sudo's
    // standpoint: real sudo exempts uid 0 from the password challenge
    // (Defaults rootpw is the rare exception) and re-enters the standard
    // exec path. Interactively, the simulator was *only* triggering
    // adduser / passwd prompts on the bare command — `sudo adduser alice`
    // when already root ran silently, dropping the GECOS / password
    // prompts. Strip the prefix and recurse so the right per-command
    // flow fires regardless of whether the user typed sudo or not.
    //
    // We skip the recursion when `-u <user>` is present: that overload
    // executes the command as someone else, the dispatcher handles the
    // identity swap, and the prompts for that target user are issued
    // there. (Edge case — root rarely uses sudo -u as a flow driver.)
    if (parts[0] === 'sudo' && isRoot) {
      let i = 1;
      // Skip valueless flags (-n -S -E -k -b -i -H -v -P).
      while (i < parts.length && /^-[nSEkbiHvP]+$/.test(parts[i])) i++;
      const hasTargetUser = i < parts.length && parts[i] === '-u';
      if (hasTargetUser) {
        return null; // dispatcher handles the identity swap silently
      }
      const rest = parts.slice(i).join(' ');
      if (!rest) return null;
      return LinuxFlowBuilder.build(rest, currentUser, currentUid, device);
    }

    if (parts[0] === 'sudo' && !isRoot) {
      return LinuxFlowBuilder.buildSudoFlow(parts, trimmed, currentUser, device);
    }

    if (parts[0] === 'su' && !isRoot) {
      return LinuxFlowBuilder.buildSuFlow(parts);
    }

    if (parts[0] === 'passwd') {
      return LinuxFlowBuilder.buildPasswdFlow(parts, currentUser, isRoot);
    }

    // Note : `useradd`/`adduser` sont intentionnellement absents de ce
    // niveau — leur interactivité (mot de passe + GECOS) est désormais
    // portée par la commande command-kernel elle-même via
    // `ctx.io.interaction` (framework §14.4), jamais par ce flux legacy.

    return null;
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
            ctx.device.setUserPassword?.(targetUser, ctx.values.get('new_password')!);
          },
        },
        { type: 'output', outputLines: ['passwd: password updated successfully'] },
      ];
    }

    // sudo adduser / sudo useradd — authentifier puis exécuter : la
    // commande migrée porte elle-même son interactivité (mot de passe +
    // GECOS pour adduser, aucune pour useradd) via `ctx.io.interaction`,
    // sur le même canal que la commande nue (§14.6).

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
      // Forward the already-validated password to su(1) on stdin so the
      // command layer performs the same authentication a real su would.
      suExecuteStep(parts.join(' ')),
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
            ctx.device.setUserPassword?.(targetUser, ctx.values.get('new_password')!);
          },
        },
        { type: 'output', outputLines: ['passwd: password updated successfully'] },
      ];
    }

    return null;
  }


}
