import { dispatchChain } from './PamDispatch';
import {
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

export class PamTransaction<H extends PamHost = PamHost> {
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
        this.host.log({ priority: 'err', module: 'libpam', service: this.service, choice: null, message });
      }
    }
    return this.loaded;
  }

  private *dispatch(choice: PamChoice, type: PamModuleType, flags: number): PamConversationFlow<number> {
    const loaded = this.stacks();
    return yield* dispatchChain(this.handle, this.registry, loaded.stacks[type], choice, flags);
  }

  *authenticate(flags = 0): PamConversationFlow<number> {
    this.handle.sanitize();
    const result = yield* this.dispatch('authenticate', 'auth', flags);
    this.handle.sanitize();
    return result;
  }

  *setcred(flags = PamFlag.ESTABLISH_CRED): PamConversationFlow<number> {
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
