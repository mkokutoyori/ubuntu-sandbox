/**
 * InteractionPlanRunner — walks a CommandInteractionPlan one collected
 * input at a time, for hosts that speak the IShell
 * pendingInput/handleInput protocol (SSH remote shells, exec adapters).
 *
 * The terminal UI renders plans through the InteractiveFlowEngine; this
 * runner is the equivalent for line-oriented hosts: `start()` advances
 * until the first prompt (or completion), then each `provide(value)`
 * consumes one user answer and advances again. Validation retries and
 * abort-on-exhaustion mirror the flow engine's semantics.
 */

import type {
  CommandInteractionPlan,
  InteractionRuntime,
  InteractionStep,
} from './CommandInteraction';

type PromptStep = Extract<InteractionStep, { kind: 'text' | 'password' | 'confirmation' }>;
type CollectStep = Extract<InteractionStep, { kind: 'collect' }>;

export interface PlanPendingInput {
  readonly kind: 'password' | 'text';
  readonly promptText: string;
}

export interface PlanAdvanceResult {
  /** Output lines produced since the last pause. */
  lines: string[];
  /** Set when the plan is waiting for one input value. */
  pending?: PlanPendingInput;
  /** True once the plan has finished (completed or aborted). */
  done: boolean;
}

export class InteractionPlanRunner {
  private idx = 0;
  private retriesUsed = 0;
  private currentPrompt: PromptStep | null = null;
  private currentCollect: CollectStep | null = null;
  private collectBuffer: string[] = [];
  private readonly values = new Map<string, string>();
  private readonly metadata = new Map<string, unknown>();

  constructor(
    private readonly plan: CommandInteractionPlan,
    private readonly exec: (command: string) => Promise<string>,
  ) {}

  /** Advance to the first prompt (or completion). Call exactly once. */
  async start(): Promise<PlanAdvanceResult> {
    return this.advance();
  }

  /** Feed the value collected for the current prompt and advance. */
  async provide(value: string): Promise<PlanAdvanceResult> {
    const collect = this.currentCollect;
    if (collect) {
      const res = collect.accept(value, this.collectBuffer);
      if (!res.done) {
        this.collectBuffer.push(value);
        return { lines: [], pending: collectPending(collect), done: false };
      }
      this.values.set(collect.storeAs, res.body ?? '');
      this.currentCollect = null;
      this.collectBuffer = [];
      this.idx++;
      return this.advance();
    }

    const step = this.currentPrompt;
    if (!step) return { lines: [], done: true };

    let effective = value;
    if (step.kind === 'confirmation' && effective.trim() === '') {
      effective = step.defaultAnswer ?? 'yes';
    }
    if (step.kind === 'text' && effective.trim() === '' && step.defaultValue !== undefined) {
      effective = step.defaultValue;
    }

    const lines: string[] = [];
    if (step.validate) {
      const res = step.validate(effective, this.values);
      if (!res.valid) {
        if (res.errorMessage) lines.push(...res.errorMessage.split('\n'));
        const budget = res.maxRetries;
        if (budget !== undefined && this.retriesUsed >= budget) {
          // Retries exhausted — the plan aborts (flow-engine semantics).
          this.currentPrompt = null;
          return { lines, done: true };
        }
        this.retriesUsed++;
        return { lines, pending: pendingFor(step), done: false };
      }
    }

    if (step.storeAs) this.values.set(step.storeAs, effective);
    this.currentPrompt = null;
    this.retriesUsed = 0;
    this.idx++;
    const next = await this.advance();
    return { lines: [...lines, ...next.lines], pending: next.pending, done: next.done };
  }

  private async advance(): Promise<PlanAdvanceResult> {
    const lines: string[] = [];
    while (this.idx < this.plan.steps.length) {
      const step = this.plan.steps[this.idx];
      if (step.kind === 'output') {
        lines.push(...step.lines);
        this.idx++;
        continue;
      }
      if (step.kind === 'run') {
        const rt: InteractionRuntime = {
          exec: this.exec,
          output: (text: string) => { if (text) lines.push(...text.split('\n')); },
          clearScreen: () => {},
          values: this.values,
          metadata: this.metadata,
        };
        await step.run(rt);
        this.idx++;
        continue;
      }
      if (step.kind === 'collect') {
        this.currentCollect = step;
        this.collectBuffer = [];
        return { lines, pending: collectPending(step), done: false };
      }
      this.currentPrompt = step;
      return { lines, pending: pendingFor(step), done: false };
    }
    return { lines, done: true };
  }
}

function collectPending(step: CollectStep): PlanPendingInput {
  return { kind: 'text', promptText: step.prompt ?? '' };
}

function pendingFor(step: PromptStep): PlanPendingInput {
  return {
    kind: step.kind === 'password' ? 'password' : 'text',
    promptText: step.prompt,
  };
}
