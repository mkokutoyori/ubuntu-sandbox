/**
 * Adapter: vendor-neutral CommandInteractionPlan (declared by device
 * shells) → the terminal flow engine's InteractiveStep[].
 *
 * This is the ONLY bridge between command-owned interaction plans and the
 * terminal: sessions call `toInteractiveSteps` and run the result through
 * the existing InteractiveFlowEngine. All vendor knowledge stays on the
 * device side of `IInteractionPlanner`.
 */

import type {
  CommandInteractionPlan,
  InteractionRuntime,
} from '@/shell/interaction/CommandInteraction';
import type { FlowContext, InteractiveStep, ValidationResult } from '../core/types';

type NeutralValidator = (
  value: string,
  values: ReadonlyMap<string, string>,
) => ValidationResult;

function adaptValidation(validate?: NeutralValidator) {
  if (!validate) return undefined;
  return (value: string, ctx: FlowContext): ValidationResult => validate(value, ctx.values);
}

function runtimeFrom(ctx: FlowContext): InteractionRuntime {
  return {
    exec: async (command: string): Promise<string> => {
      if (ctx.executeCommand) return ctx.executeCommand(command);
      const device = ctx.device as unknown as {
        executeCommand?: (cmd: string) => Promise<string> | string;
      };
      return String((await device.executeCommand?.(command)) ?? '');
    },
    output: (text: string) => ctx.onOutput?.(text),
    clearScreen: () => ctx.onClearScreen?.(),
    values: ctx.values,
    metadata: ctx.metadata,
  };
}

export function toInteractiveSteps(plan: CommandInteractionPlan): InteractiveStep[] {
  const out: InteractiveStep[] = [];
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'output':
        out.push({ type: 'output', outputLines: [...step.lines] });
        break;
      case 'text':
        out.push({
          type: 'text',
          prompt: step.prompt,
          allowEmpty: step.allowEmpty ?? false,
          defaultValue: step.defaultValue,
          storeAs: step.storeAs,
          validation: adaptValidation(step.validate),
        });
        break;
      case 'password':
        out.push({
          type: 'password',
          prompt: step.prompt,
          mask: 'hidden',
          storeAs: step.storeAs,
          validation: adaptValidation(step.validate),
        });
        break;
      case 'confirmation':
        out.push({
          type: 'confirmation',
          prompt: step.prompt,
          defaultAnswer: step.defaultAnswer,
          storeAs: step.storeAs,
          validation: adaptValidation(step.validate),
        });
        break;
      case 'run':
        out.push({
          type: 'execute',
          action: async (ctx: FlowContext) => step.run(runtimeFrom(ctx)),
        });
        break;
      case 'collect': {
        // Multi-line capture unrolls onto the flow engine's primitives:
        // text prompt → accept() evaluation → branch back until done.
        const textIdx = out.length;
        const lineKey = `__collect_line_${textIdx}`;
        const accKey = `__collect_acc_${textIdx}`;
        const doneKey = `__collect_done_${textIdx}`;
        out.push({
          type: 'text',
          prompt: step.prompt ?? '',
          allowEmpty: true,
          storeAs: lineKey,
        });
        out.push({
          type: 'execute',
          action: async (ctx: FlowContext) => {
            const line = ctx.values.get(lineKey) ?? '';
            const accRaw = ctx.metadata.get(accKey);
            const acc: string[] = Array.isArray(accRaw) ? (accRaw as string[]) : [];
            const res = step.accept(line, acc);
            if (res.done) {
              ctx.values.set(step.storeAs, res.body ?? '');
              ctx.metadata.set(doneKey, '1');
              ctx.metadata.delete(accKey);
            } else {
              acc.push(line);
              ctx.metadata.set(accKey, acc);
              ctx.metadata.set(doneKey, '0');
            }
          },
        });
        out.push({
          type: 'branch',
          predicate: (ctx: FlowContext) =>
            (ctx.metadata.get(doneKey) === '1' ? textIdx + 3 : textIdx),
        });
        break;
      }
    }
  }
  return out;
}
