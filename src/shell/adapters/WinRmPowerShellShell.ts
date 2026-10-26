import type { Equipment } from '@/network';
import { AbstractShell } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { ShellContext } from '../ShellContext';
import type { RichOutputLine, LineType } from '@/terminal/core/types';
import { styleWindowsOutput } from '@/terminal/core/windowsOutputStyle';
import { CONTINUATION_PROMPT } from '@/terminal/subshells/PowerShellSubShell';
import type { WinRmRunspace } from '@/network/devices/windows/server/winrm/WinRmClient';

export interface WinRmPowerShellOptions {
  readonly device: Equipment;
  readonly user: string;
  readonly computerName: string;
  readonly runspace: WinRmRunspace;
}

function processingFailed(computerName: string, message: string): string {
  return `Processing data from remote server ${computerName} failed with the following error message: ${message}`;
}

export class WinRmPowerShellShell extends AbstractShell {
  readonly kind = 'powershell';
  protected override exitWords: ReadonlySet<string> = new Set();
  protected override clearWords: ReadonlySet<string> = new Set(['clear', 'cls', 'clear-host']);
  protected override eofEndsSession = false;
  protected override passesTypedLines = true;

  private readonly computerName: string;
  private readonly runspace: WinRmRunspace;
  private completionOrigin: number | null = null;

  constructor(opts: WinRmPowerShellOptions) {
    super({
      device: opts.device,
      user: opts.user,
      context: new ShellContext(opts.computerName, ShellContext.userCredentials(opts.user), ''),
    });
    this.computerName = opts.computerName;
    this.runspace = opts.runspace;
  }

  getPrompt(): string {
    const prompt = this.runspace.prompt;
    return prompt === CONTINUATION_PROMPT ? prompt : `[${this.computerName}]: ${prompt}`;
  }

  protected override awaitsMoreInput(): boolean {
    return this.runspace.prompt === CONTINUATION_PROMPT;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    try {
      const reply = await this.runspace.run(line);
      return { output: reply.output === '' ? [] : reply.output.split('\n'), exit: reply.ended };
    } catch (error) {
      return { output: [processingFailed(this.computerName, error instanceof Error ? error.message : String(error))], exit: true };
    }
  }

  protected override synthesizeStyledOutput(
    output: readonly string[],
    lineType: LineType = 'output',
  ): RichOutputLine[] {
    if (lineType !== 'output') return super.synthesizeStyledOutput(output, lineType);
    return styleWindowsOutput(output);
  }

  override getCompletions(): readonly string[] {
    return [];
  }

  async getCompletionsAsync(line: string): Promise<readonly string[]> {
    try {
      const completion = await this.runspace.complete(line);
      this.completionOrigin = completion.start;
      return completion.candidates;
    } catch {
      return [];
    }
  }

  completionStart(): number | null {
    return this.completionOrigin;
  }

  protected override onDispose(): void {
    this.runspace.close();
  }
}
