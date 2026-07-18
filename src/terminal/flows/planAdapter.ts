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
  return plan.steps.map((step): InteractiveStep => {
    switch (step.kind) {
      case 'output':
        return { type: 'output', outputLines: [...step.lines] };
      case 'text':
        return {
          type: 'text',
          prompt: step.prompt,
          allowEmpty: step.allowEmpty ?? false,
          defaultValue: step.defaultValue,
          storeAs: step.storeAs,
          validation: adaptValidation(step.validate),
        };
      case 'password':
        return {
          type: 'password',
          prompt: step.prompt,
          mask: 'hidden',
          storeAs: step.storeAs,
          validation: adaptValidation(step.validate),
        };
      case 'confirmation':
        return {
          type: 'confirmation',
          prompt: step.prompt,
          defaultAnswer: step.defaultAnswer,
          storeAs: step.storeAs,
          validation: adaptValidation(step.validate),
        };
      case 'run':
        return {
          type: 'execute',
          action: async (ctx: FlowContext) => step.run(runtimeFrom(ctx)),
        };
    }
  });
}
