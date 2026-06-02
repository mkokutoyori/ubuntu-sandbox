import type { InteractiveStep, FlowContext } from '@/terminal/core/types';
import type { InputBroker } from './InputBroker';

export interface FlowRunnerEmitter {
  emit(text: string, lineType?: string): void;
  clearScreen(): void;
}

export type FlowRunnerStatus = 'ok' | 'cancelled' | 'aborted';

export interface FlowRunnerResult {
  status: FlowRunnerStatus;
  ctx: FlowContext;
}

export async function runFlowOnBroker(
  steps: readonly InteractiveStep[],
  broker: InputBroker,
  ctx: FlowContext,
  out: FlowRunnerEmitter,
): Promise<FlowRunnerResult> {
  let i = 0;
  let retries = 0;
  while (i < steps.length) {
    const step = steps[i];
    switch (step.type) {
      case 'output': {
        for (const line of step.outputLines ?? []) {
          out.emit(line, step.outputLineType ?? 'output');
        }
        i++;
        retries = 0;
        break;
      }
      case 'execute': {
        try {
          if (step.action) await step.action(ctx);
        } catch (err) {
          out.emit(err instanceof Error ? err.message : String(err), 'error');
          return { status: 'aborted', ctx };
        }
        i++;
        retries = 0;
        break;
      }
      case 'branch': {
        i = step.predicate ? step.predicate(ctx) : i + 1;
        retries = 0;
        break;
      }
      case 'password':
      case 'text': {
        const isPassword = step.type === 'password';
        const value = isPassword
          ? await broker.password(step.prompt ?? '')
          : await broker.ask(step.prompt ?? '', { default: step.defaultValue });
        if (value === null) return { status: 'cancelled', ctx };
        if (step.validation) {
          const v = step.validation(value, ctx);
          if (!v.valid) {
            retries++;
            if (v.errorMessage) out.emit(v.errorMessage, 'error');
            if (v.maxRetries !== undefined && retries > v.maxRetries) {
              return { status: 'aborted', ctx };
            }
            continue;
          }
        }
        if (step.storeAs) ctx.values.set(step.storeAs, value);
        i++;
        retries = 0;
        break;
      }
      case 'confirmation': {
        const result = await broker.confirm(step.prompt ?? '', {
          default: step.defaultAnswer === 'yes' ? true
                 : step.defaultAnswer === 'no' ? false : undefined,
        });
        if (result.status === 'cancelled' || result.status === 'closed' || result.status === 'no-host') {
          return { status: result.status === 'cancelled' ? 'cancelled' : 'aborted', ctx };
        }
        if (step.storeAs) ctx.values.set(step.storeAs, result.value ? 'yes' : 'no');
        i++;
        retries = 0;
        break;
      }
      case 'choice': {
        const options = step.options ?? [];
        if (options.length === 0) { i++; break; }
        const result = await broker.choice(
          step.prompt ?? '',
          options.map(o => o.key),
          { labels: options.map(o => o.label) },
        );
        if (result.status !== 'ok' || result.value === undefined) {
          return { status: result.status === 'cancelled' ? 'cancelled' : 'aborted', ctx };
        }
        if (step.storeAs) ctx.values.set(step.storeAs, result.value);
        i++;
        retries = 0;
        break;
      }
      default:
        i++;
    }
  }
  return { status: 'ok', ctx };
}
