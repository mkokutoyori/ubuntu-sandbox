import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { hasWildcard } from '@/powershell/runtime/PSWildcard';
import { isRegistryPath } from '@/network/devices/windows/PSRegistryProvider';
import { PROVIDER_QUALIFIER, joinProviderPath, providerSegments } from '@/powershell/runtime/PSLocationState';
import { expandPathSpec, pathItemOf } from './PathCmdlets';
import { driveNotFound, pathNotFound, type ProviderFailure } from './ProviderFailures';
import { FOREIGN_DRIVES, declaredDrive, foreignDrive, mappedPath, pathInfoOf, qualifierOf, type Declared } from './ProviderPaths';

const stackNotFound = (name: string): string => `Cannot find location stack '${name}'. It does not exist or it is not a container.`;
const resolvedToMultiple = (typed: string): ProviderFailure => ({
  message: `Cannot set the location because path '${typed}' resolved to multiple containers. You can only set the location to a single container at a time.`,
  exceptionType: 'System.ArgumentException',
  errorId: 'Argument',
  category: 'InvalidArgument',
  target: typed,
});
const NO_HISTORY_BACKWARDS = 'There is no location history left to navigate backwards.';
const NO_HISTORY_FORWARDS = 'There is no location history left to navigate forwards.';

type Located =
  | { readonly refusal: ProviderFailure }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'provider'; readonly drive: string; readonly provider: string; readonly path: string; readonly real?: string };

function currentLocation(ctx: CmdletContext): string {
  return ctx.runtime.locations.foreign ?? ctx.providers.filesystem?.getCwd() ?? 'C:\\';
}

function foreignContainer(ctx: CmdletContext, drive: string, provider: string, path: string): Located {
  const root = `${drive}:\\`;
  const registry = provider === 'registry' && ctx.providers.registry;
  const exists = registry ? path === root || registry.testPath(path) === true : path === root;
  return exists ? { kind: 'provider', drive, provider, path } : { refusal: pathNotFound(path) };
}

function declaredContainer(ctx: CmdletContext, declared: Declared, path: string): Located {
  const mapped = mappedPath(declared, path);
  const registry = isRegistryPath(mapped);
  const atRoot = path.slice(declared.Name.length + 2) === '';
  const exists = atRoot || (registry
    ? ctx.providers.registry?.testPath(mapped) === true
    : ctx.providers.filesystem?.isDirectory(mapped) === true);
  return exists
    ? { kind: 'provider', drive: declared.Name, provider: 'declared', path, real: registry ? undefined : mapped }
    : { refusal: pathNotFound(path) };
}

function locate(ctx: CmdletContext, typed: string, literal: boolean): Located {
  const state = ctx.runtime.locations;
  const qualifier = qualifierOf(typed);

  if (qualifier !== null) {
    const found = foreignDrive(qualifier);
    const declared = found === null ? declaredDrive(ctx, qualifier) : null;
    if (found === null && declared === null && qualifier.length > 1) return { refusal: driveNotFound(qualifier) };
    if (found !== null || declared !== null) {
      const name = found?.drive ?? declared!.Name;
      const rest = typed.slice(qualifier.length + 1);
      const path = rest === '' ? state.remembered(name) ?? `${name}:\\` : joinProviderPath(name, providerSegments(rest));
      return found !== null
        ? foreignContainer(ctx, found.drive, found.provider, path)
        : declaredContainer(ctx, declared!, path);
    }
  }

  if (qualifier === null && state.foreign !== null && !typed.startsWith('~')) {
    const current = qualifierOf(state.foreign) ?? '';
    const found = foreignDrive(current);
    const declared = found === null ? declaredDrive(ctx, current) : null;
    if (found !== null || declared !== null) {
      const name = found?.drive ?? declared!.Name;
      const path = state.resolve(typed) ?? `${name}:\\`;
      return found !== null
        ? foreignContainer(ctx, found.drive, found.provider, path)
        : declaredContainer(ctx, declared!, path);
    }
  }

  const fs = ctx.providers.filesystem;
  if (fs === undefined) return { refusal: pathNotFound(typed) };
  const absolute = fs.normalizePath(typed, fs.getCwd());
  if (qualifier !== null && !fs.exists(`${qualifier.toUpperCase()}:\\`)) return { refusal: driveNotFound(qualifier.toUpperCase()) };
  const matches = !literal && hasWildcard(typed)
    ? expandPathSpec(fs, absolute).filter(candidate => fs.isDirectory(candidate))
    : [absolute].filter(candidate => fs.isDirectory(candidate));
  if (matches.length === 0) return { refusal: pathNotFound(!literal && hasWildcard(typed) || fs.exists(absolute) ? typed : absolute) };
  if (matches.length > 1) return { refusal: resolvedToMultiple(typed) };
  return { kind: 'file', path: matches[0] };
}

function enter(ctx: CmdletContext, located: Exclude<Located, { refusal: ProviderFailure }>): void {
  const state = ctx.runtime.locations;
  if (located.kind === 'file') {
    state.foreign = null;
    ctx.providers.filesystem?.setCwd(located.path);
  } else {
    state.enter(located.provider, located.drive, located.path);
    if (located.real !== undefined) ctx.providers.filesystem?.setCwd(located.real);
  }
}

function relocate(ctx: CmdletContext, typed: string, literal: boolean): boolean {
  const located = locate(ctx, typed, literal);
  if ('refusal' in located) {
    ctx.emitFailure(located.refusal);
    return false;
  }
  enter(ctx, located);
  return true;
}

function setLocation(ctx: CmdletContext, typed: string, literal: boolean): boolean {
  const state = ctx.runtime.locations;
  const core = ctx.runtime.edition === 'core';
  let target = typed;
  if (core && !literal && (typed === '-' || typed === '+')) {
    const backwards = typed === '-';
    if (!(backwards ? state.canUndo() : state.canRedo())) {
      ctx.emitError(backwards ? NO_HISTORY_BACKWARDS : NO_HISTORY_FORWARDS);
      return false;
    }
    const here = currentLocation(ctx);
    target = (backwards ? state.undo(here) : state.redo(here)) ?? here;
  } else if (core) {
    state.record(currentLocation(ctx));
  }
  return relocate(ctx, target, literal);
}

function homeOf(ctx: CmdletContext): string {
  const fs = ctx.providers.filesystem;
  return fs === undefined ? 'C:\\' : fs.normalizePath('~', fs.getCwd());
}

const stackNameOf = (ctx: CmdletContext): string =>
  ctx.named['stackname'] !== undefined ? psValueToString(ctx.named['stackname']) : ctx.runtime.locations.defaultStack;

function pathArgument(ctx: CmdletContext): string {
  const explicit = ctx.named['path'] ?? ctx.named['literalpath'] ?? ctx.positional[0];
  const piped = Array.isArray(ctx.pipeInput) ? ctx.pipeInput[0] : ctx.pipeInput;
  const typed = explicit !== undefined ? psValueToString(explicit) : pathItemOf(piped ?? null);
  return typed.replace(PROVIDER_QUALIFIER, '');
}

export class SetLocationCmdlet implements ICmdlet {
  readonly name = 'set-location';
  readonly displayName = 'Set-Location';
  readonly parameters = ['Path', 'LiteralPath', 'PassThru', 'StackName'] as const;
  readonly parameterValues = { Path: 'directory', LiteralPath: 'directory' } as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly aliases = ['cd', 'chdir', 'sl'] as const;

  execute(ctx: CmdletContext): PSValue {
    if (ctx.named['stackname'] !== undefined && ctx.named['path'] === undefined && ctx.named['literalpath'] === undefined) {
      const name = psValueToString(ctx.named['stackname']);
      if (!ctx.runtime.locations.hasStack(name)) {
        ctx.emitError(stackNotFound(name));
        return null;
      }
      ctx.runtime.locations.defaultStack = name;
      return null;
    }
    const typed = pathArgument(ctx);
    const literal = ctx.named['literalpath'] !== undefined;
    if (typed === '' && ctx.runtime.edition !== 'core') return null;
    if (!setLocation(ctx, typed === '' ? homeOf(ctx) : typed, literal)) return null;
    return ctx.named['passthru'] === true ? pathInfoOf(ctx, currentLocation(ctx)) : null;
  }
}

export class PushLocationCmdlet implements ICmdlet {
  readonly name = 'push-location';
  readonly displayName = 'Push-Location';
  readonly parameters = ['Path', 'LiteralPath', 'PassThru', 'StackName'] as const;
  readonly parameterValues = { Path: 'directory', LiteralPath: 'directory' } as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly aliases = ['pushd'] as const;

  execute(ctx: CmdletContext): PSValue {
    ctx.runtime.locations.push(stackNameOf(ctx), currentLocation(ctx));
    const typed = pathArgument(ctx);
    if (typed !== '') setLocation(ctx, typed, ctx.named['literalpath'] !== undefined);
    return ctx.named['passthru'] === true ? pathInfoOf(ctx, currentLocation(ctx)) : null;
  }
}

export class PopLocationCmdlet implements ICmdlet {
  readonly name = 'pop-location';
  readonly displayName = 'Pop-Location';
  readonly parameters = ['PassThru', 'StackName'] as const;
  readonly switchParameters = ['PassThru'] as const;
  readonly aliases = ['popd'] as const;

  execute(ctx: CmdletContext): PSValue {
    const name = stackNameOf(ctx);
    const state = ctx.runtime.locations;
    if (!state.hasStack(name)) {
      ctx.emitError(stackNotFound(name));
      return null;
    }
    const previous = state.pop(name);
    if (previous !== null) setLocation(ctx, previous, true);
    return ctx.named['passthru'] === true ? pathInfoOf(ctx, currentLocation(ctx)) : null;
  }
}

export class GetLocationCmdlet implements ICmdlet {
  readonly name = 'get-location';
  readonly displayName = 'Get-Location';
  readonly parameters = ['PSProvider', 'PSDrive', 'Stack', 'StackName'] as const;
  readonly switchParameters = ['Stack'] as const;
  readonly aliases = ['pwd', 'gl'] as const;

  execute(ctx: CmdletContext): PSValue {
    const state = ctx.runtime.locations;
    if (ctx.named['stack'] === true || ctx.named['stackname'] !== undefined) {
      const name = stackNameOf(ctx);
      if (!state.hasStack(name)) {
        ctx.emitError(stackNotFound(name));
        return null;
      }
      return state.entries(name).map(entry => pathInfoOf(ctx, entry)) as PSValue;
    }

    const drive = ctx.named['psdrive'] !== undefined ? psValueToString(ctx.named['psdrive']) : null;
    if (drive !== null) return this.locationOfDrive(ctx, drive);

    const provider = ctx.named['psprovider'] !== undefined ? psValueToString(ctx.named['psprovider']) : null;
    if (provider !== null) {
      if (provider.toLowerCase() === 'filesystem') return pathInfoOf(ctx, ctx.providers.filesystem?.getCwd() ?? 'C:\\');
      const drives = FOREIGN_DRIVES[provider.toLowerCase()];
      if (drives === undefined) {
        ctx.emitError(`Cannot find the PowerShell provider '${provider}'.`);
        return null;
      }
      return pathInfoOf(ctx, state.lastOnProvider(provider.toLowerCase()) ?? `${drives[0]}:\\`);
    }

    return pathInfoOf(ctx, currentLocation(ctx));
  }

  private locationOfDrive(ctx: CmdletContext, name: string): PSValue {
    const fs = ctx.providers.filesystem;
    if (name.length === 1) {
      const letter = name.toUpperCase();
      if (fs === undefined || !fs.exists(`${letter}:\\`)) {
        ctx.emitFailure(driveNotFound(name));
        return null;
      }
      return pathInfoOf(ctx, fs.driveLocation?.(letter) ?? `${letter}:\\`);
    }
    const found = foreignDrive(name);
    const declared = found === null ? declaredDrive(ctx, name) : null;
    if (found === null && declared === null) {
      ctx.emitFailure(driveNotFound(name));
      return null;
    }
    const known = found?.drive ?? declared!.Name;
    return pathInfoOf(ctx, ctx.runtime.locations.remembered(known) ?? `${known}:\\`);
  }
}
