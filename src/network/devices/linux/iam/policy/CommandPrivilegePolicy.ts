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
    for (const spec of this.rules.get(command) ?? []) {
      if (spec.appliesWhen && !spec.appliesWhen(args, actor)) continue;
      if ((spec.satisfiedBy ?? Satisfy.root)(actor)) continue;
      return (spec.deny ?? Deny.permissionDenied)(command, args);
    }
    return null;
  }
}
