export interface PrivilegeActor {
  readonly uid: number;
  readonly user: string;
  readonly groups: readonly string[];
}

export interface PrivilegeDenial {
  readonly output: string;
  readonly exitCode: number;
}

export type PrivilegeSatisfier = (actor: PrivilegeActor) => boolean;
export type PrivilegeScope = (args: readonly string[], actor: PrivilegeActor) => boolean;
export type PrivilegeDenialRenderer = (command: string, args: readonly string[]) => PrivilegeDenial;

export interface PrivilegedCommandSpec {
  readonly appliesWhen?: PrivilegeScope;
  readonly satisfiedBy?: PrivilegeSatisfier;
  readonly deny?: PrivilegeDenialRenderer;
}

/**
 * A command's privilege requirement: either one blanket rule, or an
 * ordered list of rules for commands whose privilege requirement differs
 * by option/flag (e.g. `mount` needs nothing to list mounts but root to
 * mount something; `dmesg` needs root only for `-c`/`-C`/`-n`). Rules are
 * tried in order; the first one whose `appliesWhen` matches (or that has
 * none, i.e. always applies) decides the outcome — scope narrower rules
 * before the general case.
 */
export type PrivilegeRequirement = PrivilegedCommandSpec | readonly PrivilegedCommandSpec[];

export const Satisfy = {
  root: ((actor) => actor.uid === 0) as PrivilegeSatisfier,
  rootOrGroup(...groups: readonly string[]): PrivilegeSatisfier {
    return (actor) => actor.uid === 0 || actor.groups.some(g => groups.includes(g));
  },
} as const;

export const Deny = {
  permissionDenied: ((command) => ({
    output: `${command}: Permission denied`,
    exitCode: 1,
  })) as PrivilegeDenialRenderer,
  operationNotPermitted: ((command) => ({
    output: `${command}: Operation not permitted`,
    exitCode: 1,
  })) as PrivilegeDenialRenderer,
  withMessage(message: string, exitCode = 1): PrivilegeDenialRenderer {
    return () => ({ output: message, exitCode });
  },
} as const;

/**
 * Evaluate a single privilege spec against one invocation.
 */
export function evaluatePrivilegeSpec(
  spec: PrivilegedCommandSpec,
  command: string,
  args: readonly string[],
  actor: PrivilegeActor,
): PrivilegeDenial | null {
  if (spec.appliesWhen && !spec.appliesWhen(args, actor)) return null;
  if ((spec.satisfiedBy ?? Satisfy.root)(actor)) return null;
  return (spec.deny ?? Deny.permissionDenied)(command, args);
}

/**
 * Evaluate a command's full `PrivilegeRequirement` (one rule, or an
 * ordered list for option-dependent requirements) against one invocation.
 * Every rule is checked in order; a rule whose `appliesWhen` doesn't match
 * this invocation is a no-op, so unrelated rules don't block each other —
 * the first rule that actually applies AND is unsatisfied wins.
 *
 * This is the single place `LinuxCommand.privilege` (via `LinuxMachine`)
 * and `CommandPrivilegePolicy.check` (the by-name fallback for commands
 * not yet migrated) both resolve a requirement through.
 */
export function evaluatePrivilegeRequirement(
  requirement: PrivilegeRequirement,
  command: string,
  args: readonly string[],
  actor: PrivilegeActor,
): PrivilegeDenial | null {
  const specs = Array.isArray(requirement) ? requirement : [requirement as PrivilegedCommandSpec];
  for (const spec of specs) {
    const denial = evaluatePrivilegeSpec(spec, command, args, actor);
    if (denial) return denial;
  }
  return null;
}

export class CommandPrivilegePolicy {
  private readonly rules = new Map<string, PrivilegedCommandSpec[]>();

  declare(commands: string | readonly string[], spec: PrivilegedCommandSpec = {}): this {
    const names = typeof commands === 'string' ? [commands] : commands;
    for (const name of names) {
      const stack = this.rules.get(name) ?? [];
      stack.push(spec);
      this.rules.set(name, stack);
    }
    return this;
  }

  check(command: string, args: readonly string[], actor: PrivilegeActor): PrivilegeDenial | null {
    return evaluatePrivilegeRequirement(this.rules.get(command) ?? [], command, args, actor);
  }
}
