/**
 * Linux command-owned interactive flows (IoC).
 *
 * Owns the interactive dialogue of sudo / su / passwd / adduser — the
 * password challenges, GECOS prompts and confirmations these commands run
 * on a real system. Previously this logic lived in the terminal layer
 * (LinuxFlowBuilder); it now belongs to the device layer, next to the
 * commands whose behaviour it describes. The terminal renders the plan
 * and feeds answers back, nothing more.
 *
 * Faithfulness notes preserved from the original:
 *  - `useradd` is NEVER interactive (it silently creates the account);
 *    `adduser` is the interactive Debian/Ubuntu front-end.
 *  - root running `sudo <cmd>` skips the password challenge (uid-0
 *    exemption) and recurses into the bare command's own flow.
 */

import type {
  CommandInteractionPlan,
  InteractionRuntime,
  InteractionStep,
} from '@/shell/interaction/CommandInteraction';
import { tokenize } from '../LinuxShellParser';
import { parseAdduserArgs } from '../iam/adduserOptions';
import type { PamDialogue } from '../pam/PamDialogue';
import { PamReturn, pamStrError } from '../pam/PamReturnCode';

const MAX_SUDO_ATTEMPTS = 3;

/**
 * The device surface the planner needs. LinuxMachine satisfies this
 * structurally; tests may pass a mock.
 */
export interface LinuxPlannerDevice {
  canSudo(): boolean;
  checkPassword?(user: string, password: string): boolean;
  authenticateSudo?(user: string, password: string): boolean;
  abandonSudoAuthentication?(attempts: number, commandLine: string): void;
  beginPasswordChange?(target: string, invoker: PasswordInvoker): PamDialogue;
  setUserGecos?(
    user: string, fullName: string, room: string,
    workPhone: string, homePhone: string, other: string,
  ): void;
  userExists?(user: string): boolean;
}

export interface PasswordInvoker {
  uid: number;
  name: string;
}

export interface LinuxPlanContext {
  currentUser: string;
  currentUid: number;
}

// ─── Step fragments ─────────────────────────────────────────────────

/** Execute a command through the session path and surface its output. */
function executeCommandStep(command: string): InteractionStep {
  return {
    kind: 'run',
    run: async (rt: InteractionRuntime) => {
      const result = await rt.exec(command);
      if (result) {
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) rt.clearScreen();
        else rt.output(result);
      }
    },
  };
}

/** Like executeCommandStep, but pipes the validated su password to su(1) on
 *  stdin so the command layer performs the real authentication. */
function suExecuteStep(command: string): InteractionStep {
  return {
    kind: 'run',
    run: async (rt: InteractionRuntime) => {
      const pwd = (rt.values.get('su_password') ?? '').replace(/'/g, "'\\''");
      const result = await rt.exec(`printf '%s\\n' '${pwd}' | ${command}`);
      if (result) {
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) rt.clearScreen();
        else rt.output(result);
      }
    },
  };
}

function sudoPasswordStep(device: LinuxPlannerDevice, currentUser: string, commandLine: string): InteractionStep {
  let attempts = 0;
  return {
    kind: 'password',
    prompt: `[sudo] password for ${currentUser}:`,
    storeAs: 'sudo_password',
    validate: (pwd) => {
      const valid = device.authenticateSudo?.(currentUser, pwd) ?? false;
      if (valid) return { valid };
      attempts += 1;
      const exhausted = attempts >= MAX_SUDO_ATTEMPTS;
      if (exhausted) device.abandonSudoAuthentication?.(attempts, commandLine);
      return {
        valid,
        errorMessage: exhausted ? `sudo: ${attempts} incorrect password attempts` : 'Sorry, try again.',
        maxRetries: MAX_SUDO_ATTEMPTS - 1,
      };
    },
  };
}

function suPasswordStep(): InteractionStep {
  return {
    kind: 'password',
    prompt: 'Password:',
    storeAs: 'su_password',
    validate: () => ({ valid: true }),
  };
}

let passwordChangeCounter = 0;

function passwordChangeSteps(device: LinuxPlannerDevice, target: string, invoker: PasswordInvoker): InteractionStep[] {
  const ask = `password-change-${passwordChangeCounter++}`;
  const done = `${ask}-done`;
  let dialogue: PamDialogue | null = null;
  const current = (): PamDialogue => {
    dialogue ??= device.beginPasswordChange!(target, invoker);
    return dialogue;
  };
  const pending = (): string[] => current().takeNotices();
  return [
    { kind: 'output', get lines(): string[] { return pending(); } },
    { kind: 'label', name: ask },
    { kind: 'branch', to: () => (current().finished ? done : null) },
    {
      kind: 'password',
      get prompt(): string { return current().prompt; },
      validate: (answer) => {
        current().answer(answer);
        return { valid: true };
      },
    },
    { kind: 'output', get lines(): string[] { return pending(); } },
    { kind: 'branch', to: () => ask },
    { kind: 'label', name: done },
    {
      kind: 'output',
      get lines(): string[] {
        const code = current().code;
        return [
          ...pending(),
          ...(code === PamReturn.SUCCESS
            ? ['passwd: password updated successfully']
            : [`passwd: ${pamStrError(code)}`, 'passwd: password unchanged']),
        ];
      },
    },
  ];
}

function gecosSteps(device: LinuxPlannerDevice, targetUser: string): InteractionStep[] {
  return [
    {
      kind: 'output',
      lines: [
        `Changing the user information for ${targetUser}`,
        'Enter the new value, or press ENTER for the default',
      ],
    },
    { kind: 'text', prompt: '\tFull Name []: ', allowEmpty: true, storeAs: 'gecos_fullName' },
    { kind: 'text', prompt: '\tRoom Number []: ', allowEmpty: true, storeAs: 'gecos_room' },
    { kind: 'text', prompt: '\tWork Phone []: ', allowEmpty: true, storeAs: 'gecos_workPhone' },
    { kind: 'text', prompt: '\tHome Phone []: ', allowEmpty: true, storeAs: 'gecos_homePhone' },
    { kind: 'text', prompt: '\tOther []: ', allowEmpty: true, storeAs: 'gecos_other' },
    {
      kind: 'confirmation',
      prompt: 'Is the information correct? [Y/n] ',
      defaultAnswer: 'yes',
      storeAs: 'gecos_confirmed',
      validate: (val) => {
        const answer = val.trim().toLowerCase();
        if (answer === 'n' || answer === 'no') {
          return { valid: false, errorMessage: 'Aborted.', maxRetries: 0 };
        }
        return { valid: true };
      },
    },
    {
      kind: 'run',
      run: async (rt) => {
        device.setUserGecos?.(
          targetUser,
          rt.values.get('gecos_fullName') ?? '',
          rt.values.get('gecos_room') ?? '',
          rt.values.get('gecos_workPhone') ?? '',
          rt.values.get('gecos_homePhone') ?? '',
          rt.values.get('gecos_other') ?? '',
        );
      },
    },
  ];
}

/** Password capture + GECOS tail shared by the adduser overloads. */
function userCreationTail(
  device: LinuxPlannerDevice,
  targetUser: string,
  withPassword: boolean,
  withGecos: boolean,
  invoker: PasswordInvoker,
): InteractionStep[] {
  const passwordSteps: InteractionStep[] = withPassword ? passwordChangeSteps(device, targetUser, invoker) : [];
  const chfnSteps = withGecos ? gecosSteps(device, targetUser) : [];
  return [...passwordSteps, ...chfnSteps];
}

// ─── Per-command planners ───────────────────────────────────────────

function sudoPlan(
  device: LinuxPlannerDevice,
  parts: string[],
  fullCommand: string,
  currentUser: string,
): CommandInteractionPlan | null {
  if (!device.canSudo()) return null;

  const subParts = parts.slice(1);
  const subCmd = subParts[0];
  if (!subCmd || subCmd === '-l') return null;

  const sudoStep = sudoPasswordStep(device, currentUser, fullCommand);

  // sudo passwd with flags (e.g. -l, -u, -S) → authenticate, run as-is.
  if (subCmd === 'passwd' && subParts.length >= 2 && subParts[1].startsWith('-')) {
    return { steps: [sudoStep, executeCommandStep(fullCommand)] };
  }

  if (subCmd === 'passwd' && subParts.length === 1) {
    return { steps: [sudoStep, ...passwordChangeSteps(device, 'root', { uid: 0, name: currentUser })] };
  }

  // sudo passwd <user> — change another user's password.
  if (subCmd === 'passwd' && subParts.length >= 2 && !subParts[1].startsWith('-')) {
    const targetUser = subParts[subParts.length - 1];
    return {
      steps: [
        sudoStep,
        ...passwordChangeSteps(device, targetUser, { uid: 0, name: currentUser }),
      ],
    };
  }

  // sudo adduser <user>
  if (subCmd === 'adduser') {
    const req = parseAdduserArgs(tokenize(fullCommand).slice(2));
    const interactive = req.mode === 'create-user'
      && !!req.name
      && !req.system
      && !(device.userExists?.(req.name) ?? false);

    if (!interactive) {
      return { steps: [sudoStep, executeCommandStep(fullCommand)] };
    }

    const withPassword = !req.disabledPassword;
    const withGecos = req.gecos === undefined;
    return {
      steps: [
        sudoStep,
        executeCommandStep(fullCommand),
        ...userCreationTail(device, req.name!, withPassword, withGecos, { uid: 0, name: currentUser }),
      ],
    };
  }

  // Generic sudo <command> (includes sudo useradd — non-interactive body).
  return { steps: [sudoStep, executeCommandStep(fullCommand)] };
}

function suPlan(parts: string[]): CommandInteractionPlan {
  return {
    steps: [
      suPasswordStep(),
      suExecuteStep(parts.join(' ')),
    ],
  };
}

function passwdPlan(
  device: LinuxPlannerDevice,
  parts: string[],
  invoker: PasswordInvoker,
): CommandInteractionPlan | null {
  if (parts.length === 1) {
    return { steps: passwordChangeSteps(device, invoker.name, invoker) };
  }

  if (parts.length >= 2 && !parts[1].startsWith('-') && invoker.uid === 0) {
    return { steps: passwordChangeSteps(device, parts[parts.length - 1], invoker) };
  }

  return null;
}

function rootAdduserPlan(
  device: LinuxPlannerDevice,
  fullCommand: string,
  currentUser: string,
): CommandInteractionPlan | null {
  const req = parseAdduserArgs(tokenize(fullCommand).slice(1));
  if (req.mode !== 'create-user' || !req.name || req.system) return null;
  if (device.userExists?.(req.name) ?? false) return null;

  const withPassword = !req.disabledPassword;
  const withGecos = req.gecos === undefined;
  if (!withPassword && !withGecos) return null;

  return {
    steps: [
      executeCommandStep(fullCommand),
      ...userCreationTail(device, req.name, withPassword, withGecos, { uid: 0, name: currentUser }),
    ],
  };
}

// ─── Entry point ────────────────────────────────────────────────────

export function buildLinuxInteractionPlan(
  command: string,
  ctx: LinuxPlanContext,
  device: LinuxPlannerDevice,
): CommandInteractionPlan | null {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const isRoot = ctx.currentUid === 0;

  // Root running `sudo <cmd>`: real sudo exempts uid 0 from the password
  // challenge; strip the prefix and recurse so the bare command's flow
  // fires. Skipped for `sudo -u <user>` (identity swap handled elsewhere).
  if (parts[0] === 'sudo' && isRoot) {
    let i = 1;
    while (i < parts.length && /^-[nSEkbiHvP]+$/.test(parts[i])) i++;
    if (i < parts.length && parts[i] === '-u') return null;
    const rest = parts.slice(i).join(' ');
    if (!rest) return null;
    return buildLinuxInteractionPlan(rest, ctx, device);
  }

  if (parts[0] === 'sudo' && !isRoot) {
    return sudoPlan(device, parts, trimmed, ctx.currentUser);
  }

  if (parts[0] === 'su' && !isRoot) {
    return suPlan(parts);
  }

  if (parts[0] === 'passwd') {
    return passwdPlan(device, parts, { uid: ctx.currentUid, name: ctx.currentUser });
  }

  if (parts[0] === 'adduser' && parts.length >= 2 && isRoot) {
    return rootAdduserPlan(device, trimmed, ctx.currentUser);
  }

  // `useradd` is intentionally absent — non-interactive on real systems.
  return null;
}
