import { PamAction } from './PamControl';
import type { PamChoice, PamConversationFlow, PamHandle, PamHost } from './PamHandle';
import type { PamModuleFunction, PamModuleImplementation, PamModuleRegistry } from './PamModule';
import { PAM_RETURN_VALUES, PamReturn } from './PamReturnCode';
import { PAM_INVALID_RETVAL, type PamHandler } from './PamStackConfig';

const MUST_FAIL_CODE = PamReturn.PERM_DENIED;
const MAX_SUBSTACK_LEVEL = 16;

const UNDEF = 0;
const POSITIVE = 1;
const NEGATIVE = -1;

type FrozenChain = 'freeze' | 'may-be-frozen';

interface SubstackState {
  impression: number;
  status: number;
}

function moduleFunction<H extends PamHost>(
  implementation: PamModuleImplementation<H> | undefined, choice: PamChoice,
): PamModuleFunction<H> | undefined {
  if (implementation === undefined) return undefined;
  switch (choice) {
    case 'authenticate': return implementation.authenticate;
    case 'setcred': return implementation.setcred;
    case 'acct_mgmt': return implementation.acctMgmt;
    case 'open_session': return implementation.openSession;
    case 'close_session': return implementation.closeSession;
    case 'chauthtok': return implementation.chauthtok;
  }
}

export function chainMode(choice: PamChoice): FrozenChain {
  return choice === 'setcred' || choice === 'close_session' ? 'may-be-frozen' : 'freeze';
}

export function* dispatchChain<H extends PamHost>(
  pamh: PamHandle<H>,
  registry: PamModuleRegistry<H>,
  handlers: readonly PamHandler[],
  choice: PamChoice,
  flags: number,
): PamConversationFlow<number> {
  if (handlers.length === 0) {
    pamh.currentModule = null;
    pamh.syslog('err', `no modules loaded for \`${pamh.service}' service`);
    return MUST_FAIL_CODE;
  }
  const mode = chainMode(choice);
  const substates: SubstackState[] = Array.from({ length: MAX_SUBSTACK_LEVEL }, () => ({ impression: UNDEF, status: MUST_FAIL_CODE }));
  let impression = UNDEF;
  let status: number = MUST_FAIL_CODE;
  substates[0] = { impression, status };
  let previousLevel = 0;
  let stackLevel = 0;

  for (let depth = 0; depth < handlers.length; previousLevel = stackLevel, depth++) {
    const handler = handlers[depth];
    stackLevel = handler.stackLevel;

    if (previousLevel < stackLevel) substates[stackLevel] = { impression, status };

    let retval: number;
    if (handler.kind === 'must-fail') {
      retval = MUST_FAIL_CODE;
    } else if (handler.kind === 'substack') {
      continue;
    } else {
      const fn = moduleFunction(handler.module === null ? undefined : registry.get(handler.module), choice);
      if (fn === undefined) {
        retval = PamReturn.MODULE_UNKNOWN;
      } else {
        pamh.currentModule = handler.module;
        pamh.currentHandler = handler;
        pamh.currentArgs = handler.args;
        pamh.choice = choice;
        const outcome = fn(pamh, flags, handler.args);
        retval = typeof outcome === 'number' ? outcome : yield* outcome;
        pamh.currentModule = null;
        pamh.currentHandler = null;
        pamh.currentArgs = [];
      }
    }

    if (retval === PamReturn.INCOMPLETE) return retval;

    let cached: number;
    if (mode === 'freeze') {
      cached = handler.frozen.value = retval;
    } else {
      cached = handler.frozen.value;
      if (cached === PAM_INVALID_RETVAL) cached = retval;
    }

    let action: number;
    if (cached < PamReturn.SUCCESS || cached >= PAM_RETURN_VALUES) {
      retval = MUST_FAIL_CODE;
      action = PamAction.BAD;
    } else {
      action = handler.actions[cached];
    }

    let decisionMade = false;
    switch (action) {
      case PamAction.RESET:
        impression = substates[stackLevel].impression;
        status = substates[stackLevel].status;
        break;
      case PamAction.OK:
      case PamAction.DONE:
        if (impression === UNDEF || (impression === POSITIVE && status === PamReturn.SUCCESS)) {
          if (retval !== PamReturn.IGNORE || cached === retval) {
            impression = POSITIVE;
            status = retval;
          }
        }
        if (impression === POSITIVE && action === PamAction.DONE) decisionMade = true;
        break;
      case PamAction.BAD:
      case PamAction.DIE:
        if (impression !== NEGATIVE) {
          impression = NEGATIVE;
          status = retval === PamReturn.IGNORE ? MUST_FAIL_CODE : retval;
        }
        if (action === PamAction.DIE) decisionMade = true;
        break;
      case PamAction.IGNORE:
        break;
      default: {
        let remaining = action;
        if (remaining > 0) {
          if (mode === 'may-be-frozen' && (impression === UNDEF || (impression === POSITIVE && status === PamReturn.SUCCESS))) {
            if (retval !== PamReturn.IGNORE || cached === retval) {
              impression = POSITIVE;
              status = retval;
            }
          }
          while (depth + 1 < handlers.length && handlers[depth + 1].stackLevel >= stackLevel && remaining > 0) {
            do {
              depth++;
            } while (depth + 1 < handlers.length && handlers[depth + 1].stackLevel > stackLevel);
            remaining--;
          }
        }
        if (remaining !== 0) {
          pamh.currentModule = null;
          pamh.syslog('err', 'bad jump in stack');
          impression = NEGATIVE;
          status = MUST_FAIL_CODE;
        }
      }
    }

    if (decisionMade) {
      while (depth + 1 < handlers.length && handlers[depth + 1].stackLevel >= stackLevel) depth++;
    }
  }

  if (status === PamReturn.SUCCESS && impression !== POSITIVE) status = MUST_FAIL_CODE;
  return status;
}
