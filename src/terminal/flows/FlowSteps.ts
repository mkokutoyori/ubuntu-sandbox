/**
 * FlowSteps — Shared reusable flow step factories.
 *
 * Eliminates duplicated password validation, confirmation prompts, and retry
 * logic across CiscoFlowBuilder, HuaweiFlowBuilder, and LinuxFlowBuilder.
 *
 * Each factory returns an `InteractiveStep` that can be composed into flows.
 */

import type { InteractiveStep, FlowContext, ValidationResult } from '../core/types';

// ─── Constants ────────────────────────────────────────────────────

/** Default max retries for password prompts (3 attempts total = 2 retries). */
export const DEFAULT_MAX_PASSWORD_RETRIES = 2;

/** Default max attempts for sudo-style authentication. */
export const MAX_SUDO_ATTEMPTS = 3;

/** Default max attempts for su-style authentication. */
export const MAX_SU_ATTEMPTS = 3;

// ─── Password Step Factory ───────────────────────────────────────

export interface PasswordStepOptions {
  /** Prompt text (default: 'Password:') */
  prompt?: string;
  /** Key to store password under (default: 'password') */
  storeAs?: string;
  /** Mask style (default: 'hidden') */
  mask?: 'hidden' | 'dots' | 'asterisks';
  /** Validator function: (password, context) → boolean */
  validator: (password: string, ctx: FlowContext) => boolean;
  /** Max retries before abort (default: DEFAULT_MAX_PASSWORD_RETRIES) */
  maxRetries?: number;
  /** Error message on failure */
  errorMessage: string;
}

/**
 * Create a password validation step.
 *
 * Usage:
 * ```ts
 * FlowSteps.password({
 *   prompt: 'Password:',
 *   validator: (pwd, ctx) => ctx.device.checkPassword(ctx.currentUser, pwd),
 *   errorMessage: 'Sorry, try again.',
 *   maxRetries: 2,
 * })
 * ```
 */
export function password(opts: PasswordStepOptions): InteractiveStep {
  return {
    type: 'password',
    prompt: opts.prompt ?? 'Password:',
    storeAs: opts.storeAs ?? 'password',
    mask: opts.mask ?? 'hidden',
    validation: (pwd: string, ctx: FlowContext): ValidationResult => {
      const valid = opts.validator(pwd, ctx);
      return {
        valid,
        errorMessage: valid ? undefined : opts.errorMessage,
        maxRetries: opts.maxRetries ?? DEFAULT_MAX_PASSWORD_RETRIES,
      };
    },
  };
}

// ─── Enable Password Step (Cisco/Huawei) ─────────────────────────

/**
 * Create an enable/super password step (Cisco `enable`, Huawei `super`).
 *
 * @param errorMessage Vendor-specific error (Cisco: '% Bad secrets', Huawei: 'Error: Failed to verify...')
 */
export function enablePassword(errorMessage: string): InteractiveStep {
  return password({
    prompt: 'Password:',
    storeAs: 'enable_password',
    validator: (pwd, ctx) => {
      const device = ctx.device as any;
      return typeof device.checkEnablePassword === 'function'
        ? device.checkEnablePassword(pwd)
        : true;
    },
    maxRetries: DEFAULT_MAX_PASSWORD_RETRIES,
    errorMessage,
  });
}

// ─── Sudo Password Step ──────────────────────────────────────────

/**
 * Create a sudo password validation step.
 */
export function sudoPassword(currentUser?: string): InteractiveStep {
  return password({
    prompt: `[sudo] password for ${currentUser ?? 'user'}:`,
    storeAs: 'sudo_password',
    validator: (pwd, ctx) => ctx.device.checkPassword(currentUser ?? ctx.currentUser, pwd),
    maxRetries: MAX_SUDO_ATTEMPTS - 1,
    errorMessage: 'Sorry, try again.',
  });
}

// ─── SU Password Step ────────────────────────────────────────────

/**
 * Create an su password validation step.
 */
export function suPassword(targetUser: string): InteractiveStep {
  return password({
    prompt: 'Password:',
    storeAs: 'su_password',
    validator: (pwd, ctx) => ctx.device.checkPassword(targetUser, pwd),
    maxRetries: MAX_SU_ATTEMPTS - 1,
    errorMessage: 'su: Authentication failure',
  });
}

// ─── Current Password Step (passwd) ──────────────────────────────

/**
 * Create a "current password" verification step (for passwd command).
 */
export function currentPassword(): InteractiveStep {
  return password({
    prompt: '(current) UNIX password:',
    storeAs: 'current_password',
    validator: (pwd, ctx) => ctx.device.checkPassword(ctx.currentUser, pwd),
    maxRetries: 0,
    errorMessage: 'passwd: Authentication token manipulation error\npasswd: password unchanged',
  });
}

// ─── New Password Steps ──────────────────────────────────────────

/**
 * Create a pair of steps for new password entry + confirmation.
 */
export function newPasswordPair(): InteractiveStep[] {
  return [
    {
      type: 'password',
      prompt: 'New password:',
      storeAs: 'new_password',
      mask: 'hidden',
      validation: (pwd: string): ValidationResult => ({
        valid: pwd.length >= 1,
        errorMessage: 'No password supplied',
        maxRetries: 0,
      }),
    },
    {
      type: 'password',
      prompt: 'Retype new password:',
      storeAs: 'confirm_password',
      mask: 'hidden',
      validation: (pwd: string, ctx: FlowContext): ValidationResult => ({
        valid: pwd === ctx.values.get('new_password'),
        errorMessage: 'Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged',
        maxRetries: 0,
      }),
    },
  ];
}

// ─── Confirmation Step Factory ───────────────────────────────────

export interface ConfirmationStepOptions {
  /** Prompt text */
  prompt: string;
  /** Default answer (default: 'yes') */
  defaultAnswer?: 'yes' | 'no';
  /** Key to store answer under */
  storeAs?: string;
  /** Optional: message when user declines */
  cancelMessage?: string;
}

/**
 * Create a yes/no confirmation step.
 *
 * Usage:
 * ```ts
 * FlowSteps.confirmation({
 *   prompt: 'Proceed with reload? [confirm]',
 *   defaultAnswer: 'yes',
 *   cancelMessage: 'Reload cancelled.',
 * })
 * ```
 */
export function confirmation(opts: ConfirmationStepOptions): InteractiveStep {
  const step: InteractiveStep = {
    type: 'confirmation',
    prompt: opts.prompt,
    defaultAnswer: opts.defaultAnswer ?? 'yes',
    storeAs: opts.storeAs,
  };

  if (opts.cancelMessage) {
    step.validation = (val: string): ValidationResult => {
      const answer = val.trim().toLowerCase();
      if (answer === 'n' || answer === 'no') {
        return { valid: false, errorMessage: opts.cancelMessage, maxRetries: 0 };
      }
      return { valid: true };
    };
  }

  return step;
}

// ─── Output Step Factory ─────────────────────────────────────────

/**
 * Create an output step that displays text lines.
 */
export function output(lines: string[], lineType?: string): InteractiveStep {
  return {
    type: 'output',
    outputLines: lines,
    outputLineType: lineType as any,
  };
}

// ─── Execute Step Factory ────────────────────────────────────────

/**
 * Create an execute step that runs an async action.
 */
export function execute(action: (ctx: FlowContext) => Promise<void>): InteractiveStep {
  return {
    type: 'execute',
    action,
  };
}

// ─── Branch Step Factory ─────────────────────────────────────────

/**
 * Create a branch step that conditionally jumps to a different step index.
 */
export function branch(predicate: (ctx: FlowContext) => number): InteractiveStep {
  return {
    type: 'branch',
    predicate,
  };
}
