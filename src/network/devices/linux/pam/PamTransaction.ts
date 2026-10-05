import { dispatchChain } from './PamDispatch';
import {
  PAM_LIBRARY_NAME,
  PamHandle,
  type PamChoice,
  type PamConversationFlow,
  type PamConversationRequest,
  type PamHost,
  type PamReply,
} from './PamHandle';
import type { PamModuleRegistry } from './PamModule';
import { PamFlag, PamReturn } from './PamReturnCode';
import { loadPamStacks, type LoadedPamStacks, type PamFileSource, type PamModuleType } from './PamStackConfig';

export type PamConversation = (request: PamConversationRequest) => readonly PamReply[];

export type AsyncPamConversation = (request: PamConversationRequest) => readonly PamReply[] | Promise<readonly PamReply[]>;

export function runPamSync<T>(flow: PamConversationFlow<T>, conversation: PamConversation): T {
  let step: IteratorResult<PamConversationRequest, T> = flow.next();
  while (step.done !== true) step = flow.next(conversation(step.value));
  return step.value;
}

export async function runPamAsync<T>(flow: PamConversationFlow<T>, conversation: AsyncPamConversation): Promise<T> {
  let step: IteratorResult<PamConversationRequest, T> = flow.next();
  while (step.done !== true) step = flow.next(await conversation(step.value));
  return step.value;
}

export const NO_CONVERSATION: PamConversation = (request) => request.map(() => ({ text: null }));

const DELAY_MULTIPLIER = 1664525;
const DELAY_INCREMENT = 1013904223;

export function computeFailDelay(seed: number, base: number): number {
  let state = seed >>> 0;
  let sum = 0;
  for (let round = 0; round < 3; round++) {
    state = (Math.imul(DELAY_MULTIPLIER, state) + DELAY_INCREMENT) >>> 0;
    sum += Math.floor(state / 10) % 1_000_000;
  }
  const spread = sum / 3 / 1e6 - 0.5;
  return Math.floor(base * (1 + spread)) >>> 0;
}

export class PamTransaction<H extends PamHost = PamHost> {
  private pendingFailDelayUs = 0;
  readonly handle: PamHandle<H>;
  private loaded: LoadedPamStacks | null = null;

  constructor(
    readonly service: string,
    private readonly host: H,
    private readonly registry: PamModuleRegistry<H>,
    private readonly files: PamFileSource,
  ) {
    this.handle = new PamHandle<H>(service, host);
  }

  private stacks(): LoadedPamStacks {
    if (this.loaded === null) {
      this.loaded = loadPamStacks(this.service, this.files);
      for (const message of this.loaded.diagnostics) {
        this.host.log({ priority: 'err', module: PAM_LIBRARY_NAME, service: this.service, choice: null, message });
      }
    }
    return this.loaded;
  }

  private *dispatch(choice: PamChoice, type: PamModuleType, flags: number): PamConversationFlow<number> {
    const loaded = this.stacks();
    return yield* dispatchChain(this.handle, this.registry, loaded.stacks[type], choice, flags);
  }

  end(): void {
    this.handle.releaseData();
  }

  *authenticate(flags = 0): PamConversationFlow<number> {
    this.handle.sanitize();
    const timerBegin = Math.floor(this.host.now() / 1000);
    const result = yield* this.dispatch('authenticate', 'auth', flags);
    this.pendingFailDelayUs = result !== PamReturn.SUCCESS && this.handle.failDelay.set
      ? computeFailDelay(timerBegin, this.handle.failDelay.delayUs)
      : 0;
    this.handle.failDelay.set = false;
    this.handle.sanitize();
    return result;
  }

  get failDelayUs(): number {
    return this.pendingFailDelayUs;
  }

  *setcred(flags: number = PamFlag.ESTABLISH_CRED): PamConversationFlow<number> {
    return yield* this.dispatch('setcred', 'auth', flags);
  }

  *acctMgmt(flags = 0): PamConversationFlow<number> {
    return yield* this.dispatch('acct_mgmt', 'account', flags);
  }

  *openSession(flags = 0): PamConversationFlow<number> {
    return yield* this.dispatch('open_session', 'session', flags);
  }

  *closeSession(flags = 0): PamConversationFlow<number> {
    return yield* this.dispatch('close_session', 'session', flags);
  }

  *chauthtok(flags = 0): PamConversationFlow<number> {
    if ((flags & (PamFlag.PRELIM_CHECK | PamFlag.UPDATE_AUTHTOK)) !== 0) return PamReturn.SYSTEM_ERR;
    this.handle.sanitize();
    let result = yield* this.dispatch('chauthtok', 'password', flags | PamFlag.PRELIM_CHECK);
    if (result === PamReturn.SUCCESS) {
      result = yield* this.dispatch('chauthtok', 'password', flags | PamFlag.UPDATE_AUTHTOK);
    }
    this.handle.sanitize();
    return result;
  }
}
