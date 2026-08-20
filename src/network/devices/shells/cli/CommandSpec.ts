import type { CommandAction, ParamSpec } from '../CommandTrie';

export interface CommandContinuation {
  keyword: string;
  description: string;
  leadingOnly?: boolean;
}

export interface CommandSpec {
  path: string;
  description: string;
  run: CommandAction;
  args?: readonly ParamSpec[];
  continuations?: ReadonlyArray<string | CommandContinuation>;
  freeform?: boolean;
  platforms?: readonly string[];
  serialize?: (device: unknown) => string[];
}

export class CommandSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSpecError';
  }
}

export function validateCommandSpec(spec: CommandSpec): void {
  const path = spec.path?.trim() ?? '';
  if (path.length === 0) {
    throw new CommandSpecError('a command spec needs a path');
  }
  if ((spec.description ?? '').trim().length === 0) {
    throw new CommandSpecError(`${path}: a command spec needs a description`);
  }
  if (typeof spec.run !== 'function') {
    throw new CommandSpecError(`${path}: a command spec needs a run function`);
  }
  const declaresTail = (spec.args?.length ?? 0) > 0
    || (spec.continuations?.length ?? 0) > 0
    || spec.freeform === true;
  if (specReadsArguments(spec) && !declaresTail) {
    throw new CommandSpecError(
      `${path}: declare args, continuations, or freeform: true — what follows a command is not optional to state`);
  }
  if (spec.freeform === true && (spec.args?.length ?? 0) > 0) {
    throw new CommandSpecError(`${path}: freeform and args are exclusive`);
  }
  for (const arg of spec.args ?? []) {
    if ((arg.description ?? '').trim().length === 0) {
      throw new CommandSpecError(`${path}: argument ${arg.name} needs a description`);
    }
    if (arg.type === 'ENUM' && (arg.values?.length ?? 0) === 0) {
      throw new CommandSpecError(`${path}: argument ${arg.name} is an ENUM with no values`);
    }
  }
}

export function specReadsArguments(spec: CommandSpec): boolean {
  return spec.run.length > 0;
}

export function specIsGreedy(spec: CommandSpec): boolean {
  return spec.freeform === true || (spec.continuations?.length ?? 0) > 0;
}

export function specAppliesTo(spec: CommandSpec, platform: string | null): boolean {
  if (!spec.platforms || spec.platforms.length === 0) return true;
  if (platform === null) return true;
  return spec.platforms.includes(platform);
}
