import { isInteractionPlanner } from './CommandInteraction';
import {
  InteractionPlanRunner, type PlanAdvanceResult, type PlanPendingInput,
} from './InteractionPlanRunner';

export interface VtyInteractionHost {
  readonly shell: unknown;
  readonly device: unknown;
  run(line: string): string | Promise<string>;
  settle(output: string): string;
}

export class VtyInteraction {
  private runner: InteractionPlanRunner | null = null;
  private pending: PlanPendingInput | null = null;

  constructor(private readonly host: VtyInteractionHost) {}

  execute(rawInput: string): string | Promise<string> {
    this.pending = null;
    const plan = this.planFor(rawInput);
    if (plan === null) {
      const result = this.host.run(rawInput);
      return result instanceof Promise ? result.then((out) => this.host.settle(out)) : this.host.settle(result);
    }
    const runner = new InteractionPlanRunner(plan, async (line) => this.host.settle(await this.host.run(line)));
    this.runner = runner;
    return runner.start().then((step) => this.advance(step));
  }

  lastPendingInput(): PlanPendingInput | null {
    return this.pending;
  }

  async handleInput(value: string): Promise<string> {
    if (this.runner === null) return '';
    return this.advance(await this.runner.provide(value));
  }

  private planFor(rawInput: string) {
    const shell = this.host.shell;
    if (!isInteractionPlanner(shell)) return null;
    return shell.interactionPlanFor(rawInput, {
      mode: (shell as unknown as { getMode?: () => string }).getMode?.() ?? 'privileged',
      device: this.host.device,
      onVtyLine: true,
    });
  }

  private advance(step: PlanAdvanceResult): string {
    if (step.done) this.runner = null;
    this.pending = step.done ? null : step.pending ?? null;
    return this.host.settle(step.lines.join('\n'));
  }
}
