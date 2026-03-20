/**
 * InteractiveFlowEngine — A reusable state machine for multi-step
 * interactive terminal prompts (passwords, wizards, confirmations).
 *
 * Design:
 *   - Steps are defined declaratively via InteractiveStep[]
 *   - The engine processes non-input steps automatically
 *   - On input steps (password, text, confirmation, choice), it pauses
 *     and returns a TerminalResponse with the appropriate InputDirective
 *   - The session calls advance(userInput) when the user submits
 *   - The engine validates, stores, and continues to the next step
 *
 * This replaces the monolithic buildInteractiveSteps()/processInteractiveSteps()
 * pattern in LinuxTerminalSession with a vendor-agnostic, extensible engine.
 */

import type {
  InteractiveStep, FlowContext, ValidationResult,
  TerminalResponse, InputDirective, RichOutputLine,
  PasswordDirective, TextPromptDirective, ConfirmationDirective,
  ChoiceDirective, CommandDirective,
} from './types';
import type { IOutputFormatter } from './OutputFormatter';

// ─── Flow Engine ────────────────────────────────────────────────────

export class InteractiveFlowEngine {
  private steps: InteractiveStep[];
  private currentIndex: number = 0;
  private context: FlowContext;
  private formatter: IOutputFormatter;
  private retryCount: number = 0;

  /** Prompt to return when the flow completes (the session's normal prompt) */
  private completionPrompt: string;

  constructor(
    steps: InteractiveStep[],
    context: FlowContext,
    formatter: IOutputFormatter,
    completionPrompt: string,
  ) {
    this.steps = steps;
    this.context = context;
    this.formatter = formatter;
    this.completionPrompt = completionPrompt;
  }

  /** Whether all steps have been processed */
  get isComplete(): boolean {
    return this.currentIndex >= this.steps.length;
  }

  /** Get the flow context (for reading collected values after completion) */
  getContext(): FlowContext {
    return this.context;
  }

  /**
   * Advance the flow.
   *
   * - Without userInput: process automatic steps until an input step is reached.
   * - With userInput: validate, store, then continue processing.
   *
   * Returns a TerminalResponse telling the view what to display and what input to collect.
   */
  async advance(userInput?: string): Promise<TerminalResponse> {
    // Handle user input from the current input step
    if (userInput !== undefined && this.currentIndex < this.steps.length) {
      const step = this.steps[this.currentIndex];
      const isInputStep = step.type === 'password' || step.type === 'text'
        || step.type === 'confirmation' || step.type === 'choice';

      if (isInputStep) {
        // Validate
        if (step.validation) {
          const result = step.validation(userInput, this.context);
          if (!result.valid) {
            this.retryCount++;
            if (result.maxRetries !== undefined && this.retryCount > result.maxRetries) {
              return this.buildAbortResponse(result.errorMessage);
            }
            return this.buildRetryResponse(step, result.errorMessage);
          }
        }

        // Store value
        if (step.storeAs) {
          this.context.values.set(step.storeAs, userInput);
        }

        this.currentIndex++;
        this.retryCount = 0;
      }
    }

    // Process automatic steps until we hit an input step or finish
    return this.processUntilPause();
  }

  /**
   * Process steps sequentially, accumulating output lines.
   * Pauses when an input step is reached or all steps are done.
   */
  private async processUntilPause(): Promise<TerminalResponse> {
    const accumulatedLines: RichOutputLine[] = [];

    while (this.currentIndex < this.steps.length) {
      const step = this.steps[this.currentIndex];

      switch (step.type) {
        case 'output': {
          if (step.outputLines) {
            for (const text of step.outputLines) {
              const formatted = this.formatter.formatOutput(text, step.outputLineType ?? 'output');
              accumulatedLines.push(...formatted);
            }
          }
          this.currentIndex++;
          break;
        }

        case 'execute': {
          if (step.action) {
            try {
              await step.action(this.context);
            } catch (err) {
              const errorText = err instanceof Error ? err.message : String(err);
              accumulatedLines.push(
                ...this.formatter.formatOutput(errorText, 'error'),
              );
              // Abort the flow on execute error
              return this.buildCompletionResponse(accumulatedLines);
            }
          }
          this.currentIndex++;
          break;
        }

        case 'branch': {
          if (step.predicate) {
            this.currentIndex = step.predicate(this.context);
          } else {
            this.currentIndex++;
          }
          break;
        }

        // Input steps — pause and return directive
        case 'password': {
          const directive: PasswordDirective = {
            type: 'password',
            prompt: step.prompt ?? 'Password:',
            mask: step.mask ?? 'hidden',
            maxAttempts: step.validation ? undefined : undefined,
            attemptsRemaining: undefined,
          };

          // Display the prompt as an output line
          accumulatedLines.push(
            ...this.formatter.formatOutput(directive.prompt, 'output'),
          );

          return {
            lines: accumulatedLines,
            inputDirective: directive,
            scrollToBottom: true,
            clearScreen: false,
            bell: false,
          };
        }

        case 'text': {
          const directive: TextPromptDirective = {
            type: 'text-prompt',
            prompt: step.prompt ?? '',
            defaultValue: step.defaultValue,
            allowEmpty: step.allowEmpty ?? true,
          };

          return {
            lines: accumulatedLines,
            inputDirective: directive,
            scrollToBottom: true,
            clearScreen: false,
            bell: false,
          };
        }

        case 'confirmation': {
          const directive: ConfirmationDirective = {
            type: 'confirmation',
            prompt: step.prompt ?? 'Continue? [Y/n]',
            defaultAnswer: step.defaultAnswer,
          };

          return {
            lines: accumulatedLines,
            inputDirective: directive,
            scrollToBottom: true,
            clearScreen: false,
            bell: false,
          };
        }

        case 'choice': {
          const directive: ChoiceDirective = {
            type: 'choice',
            prompt: step.prompt ?? 'Choose:',
            options: step.options ?? [],
          };

          return {
            lines: accumulatedLines,
            inputDirective: directive,
            scrollToBottom: true,
            clearScreen: false,
            bell: false,
          };
        }

        default: {
          // Unknown step type — skip
          this.currentIndex++;
          break;
        }
      }
    }

    // All steps done — return to normal command input
    return this.buildCompletionResponse(accumulatedLines);
  }

  /** Build a response for flow completion (return to normal command mode) */
  private buildCompletionResponse(lines: RichOutputLine[]): TerminalResponse {
    const directive: CommandDirective = {
      type: 'command',
      prompt: this.completionPrompt,
    };

    return {
      lines,
      inputDirective: directive,
      scrollToBottom: true,
      clearScreen: false,
      bell: false,
    };
  }

  /** Build a retry response (validation failed, ask again) */
  private buildRetryResponse(step: InteractiveStep, errorMessage?: string): TerminalResponse {
    const lines: RichOutputLine[] = [];

    if (errorMessage) {
      lines.push(...this.formatter.formatOutput(errorMessage, 'error'));
    }

    // Re-show the prompt
    if (step.prompt) {
      lines.push(...this.formatter.formatOutput(step.prompt, 'output'));
    }

    // Rebuild the directive for the same step
    let directive: InputDirective;
    switch (step.type) {
      case 'password':
        directive = {
          type: 'password',
          prompt: step.prompt ?? 'Password:',
          mask: step.mask ?? 'hidden',
        };
        break;
      case 'text':
        directive = {
          type: 'text-prompt',
          prompt: step.prompt ?? '',
          defaultValue: step.defaultValue,
          allowEmpty: step.allowEmpty ?? true,
        };
        break;
      case 'confirmation':
        directive = {
          type: 'confirmation',
          prompt: step.prompt ?? 'Continue? [Y/n]',
          defaultAnswer: step.defaultAnswer,
        };
        break;
      default:
        directive = { type: 'command', prompt: this.completionPrompt };
    }

    return {
      lines,
      inputDirective: directive,
      scrollToBottom: true,
      clearScreen: false,
      bell: false,
    };
  }

  /** Build an abort response (too many retries, permission denied, etc.) */
  private buildAbortResponse(errorMessage?: string): TerminalResponse {
    const lines: RichOutputLine[] = [];
    if (errorMessage) {
      lines.push(...this.formatter.formatOutput(errorMessage, 'error'));
    }

    return {
      lines,
      inputDirective: { type: 'command', prompt: this.completionPrompt },
      scrollToBottom: true,
      clearScreen: false,
      bell: true,
    };
  }
}
