import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function text(ctx: CmdletContext, name: string): string | undefined {
  const value = ctx.named[name];
  return value === undefined || value === null ? undefined : psValueToString(value);
}

export class StartTranscriptCmdlet implements ICmdlet {
  readonly name = 'start-transcript';
  readonly displayName = 'Start-Transcript';
  readonly aliases = [] as const;
  readonly parameters = ['Path', 'LiteralPath', 'OutputDirectory', 'Append', 'Force', 'NoClobber', 'IncludeInvocationHeader', 'UseMinimalHeader'] as const;

  execute(ctx: CmdletContext): PSValue {
    const port = ctx.providers.transcript;
    if (!port) return null;
    const positional = ctx.positional[0] === undefined ? undefined : psValueToString(ctx.positional[0]);
    const outcome = port.start({
      path: text(ctx, 'path') ?? text(ctx, 'literalpath') ?? positional,
      outputDirectory: text(ctx, 'outputdirectory'),
      append: ctx.named['append'] === true,
      force: ctx.named['force'] === true,
      noClobber: ctx.named['noclobber'] === true,
      includeInvocationHeader: ctx.named['includeinvocationheader'] === true,
      useMinimalHeader: ctx.named['useminimalheader'] === true,
    });
    if ('error' in outcome) {
      ctx.emitError(`Start-Transcript: Transcription cannot be started due to the error: ${outcome.error}`);
      return null;
    }
    return `Transcript started, output file is ${outcome.path}`;
  }
}

export class StopTranscriptCmdlet implements ICmdlet {
  readonly name = 'stop-transcript';
  readonly displayName = 'Stop-Transcript';
  readonly aliases = [] as const;
  readonly parameters = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const port = ctx.providers.transcript;
    if (!port) return null;
    const outcome = port.stop();
    if ('error' in outcome) {
      ctx.emitError(`Stop-Transcript: An error occurred stopping transcription: ${outcome.error}`);
      return null;
    }
    return `Transcript stopped, output file is ${outcome.path}`;
  }
}
