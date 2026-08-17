import {
  CISCO_IOS_MODES,
  CLIStateMachine,
  type ModeHierarchy,
} from '../network/devices/shells/CLIStateMachine';
import {
  CISCO_IOS_PROMPTS,
  buildPrompt,
  type PromptMap,
} from '../network/devices/shells/PromptBuilder';

export interface SessionOptions {
  readonly privilegeLevel?: number;
  readonly initialMode?: string;
  readonly hierarchy?: ModeHierarchy;
  readonly prompts?: PromptMap;
  readonly topLevel?: string;
  readonly execLevel?: string;
}

export class CliSession {
  readonly fields: Record<string, string | undefined> = {};
  privilegeLevel: number;
  viewName?: string;

  private readonly machine: CLIStateMachine;
  private readonly prompts: PromptMap;
  private readonly hierarchy: ModeHierarchy;
  private readonly topLevelMode: string;
  private readonly execMode: string;

  constructor(
    readonly hostname: string,
    readonly device: unknown,
    options: SessionOptions = {},
  ) {
    this.privilegeLevel = options.privilegeLevel ?? 15;
    this.prompts = options.prompts ?? CISCO_IOS_PROMPTS;
    this.hierarchy = options.hierarchy ?? CISCO_IOS_MODES;
    this.topLevelMode = options.topLevel ?? 'user';
    this.execMode = options.execLevel ?? 'privileged';
    this.machine = new CLIStateMachine(
      options.initialMode ?? 'user',
      this.hierarchy, this.topLevelMode, this.execMode,
    );
  }

  get mode(): string { return this.machine.mode; }

  enter(mode: string): void { this.machine.mode = mode; }

  exitOneLevel(): void { this.applyClear(this.machine.exit()); }

  endToExec(): void { this.applyClear(this.machine.end()); }

  private applyClear(result: { newMode: string; fieldsToCllear: string[] }): void {
    for (const field of result.fieldsToCllear) delete this.fields[field];
  }

  configAncestors(): readonly string[] {
    if (!this.machine.isConfigMode()) return [];

    const chain: string[] = [];
    let current = this.hierarchy[this.mode]?.parent ?? null;
    while (current !== null && current !== this.topLevelMode && current !== this.execMode) {
      chain.push(current);
      current = this.hierarchy[current]?.parent ?? null;
    }
    return chain;
  }

  prompt(): string {
    return buildPrompt(this.mode, this.hostname, this.prompts, this.fields);
  }
}

export function newSession(
  hostname: string, device: unknown, options: SessionOptions = {},
): CliSession {
  return new CliSession(hostname, device, options);
}

export function promptOf(session: CliSession): string {
  return session.prompt();
}
