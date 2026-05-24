/**
 * IntentRunner — drives a {@link ShellFlow} on behalf of a terminal
 * session. The runner is the bridge between the asynchronous flow (which
 * yields TerminalIntents and awaits InputResponses) and the imperative
 * terminal API the session exposes today (addLine, set input mode, push
 * sub-shell, …).
 *
 * The session creates one runner per action invocation, calls `start()`,
 * and forwards user-submitted values via `respond()` until the runner
 * emits a `complete` intent.
 */

import type { IntentChannel, ShellAction, ShellActionContext, ShellFlow } from './ShellAction';
import type { TerminalIntent, InputResponse } from './TerminalIntent';

export interface IntentHandler {
  onIntent(intent: TerminalIntent): void | Promise<void>;
}

export class IntentRunner {
  private pendingResponse: ((res: InputResponse) => void) | null = null;
  private finished = false;
  private startedPromise: Promise<void> | null = null;

  constructor(
    private readonly flow: ShellFlow,
    private readonly ctx: ShellActionContext,
    private readonly handler: IntentHandler,
  ) {}

  get isWaitingForInput(): boolean { return this.pendingResponse !== null; }
  get isFinished(): boolean { return this.finished; }

  start(): Promise<void> {
    if (this.startedPromise) return this.startedPromise;
    const channel: IntentChannel = {
      emit: async (intent) => {
        await this.handler.onIntent(intent);
      },
      ask: (promptIntent) => {
        return new Promise<InputResponse>(async (resolve) => {
          this.pendingResponse = resolve;
          await this.handler.onIntent(promptIntent);
        });
      },
    };

    this.startedPromise = (async () => {
      try {
        await this.flow(this.ctx, channel);
      } finally {
        this.finished = true;
        await this.handler.onIntent({ kind: 'complete', exitCode: 0 });
      }
    })();
    return this.startedPromise;
  }

  respond(response: InputResponse): void {
    const r = this.pendingResponse;
    if (!r) return;
    this.pendingResponse = null;
    r(response);
  }
}

export function runAction(
  action: ShellAction,
  ctx: ShellActionContext,
  handler: IntentHandler,
): IntentRunner {
  const runner = new IntentRunner(action.flow, ctx, handler);
  void runner.start();
  return runner;
}
