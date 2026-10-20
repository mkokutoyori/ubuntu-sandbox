import { RS_RET } from '../engine/Log';
import type { ActionModuleInstance, ActionWorker, ModuleContext, OutputModule, SelectorParse, TemplateRequest } from '../engine/Modules';

class OmdiscardInstance implements ActionModuleInstance {
  readonly moduleName = 'omdiscard';
  readonly templates: TemplateRequest[] = [];
  readonly description = 'discard';

  createWorker(): ActionWorker {
    return { doAction: () => 'discard', close: () => undefined };
  }
}

function parseSelector(line: string, context: ModuleContext): SelectorParse {
  if (!line.startsWith('~')) return { status: 'unprocessed' };
  context.runtime.log(4, RS_RET.DEPRECATED, "warning: ~ action is deprecated, consider using the 'stop' statement instead");
  return { status: 'ok', instance: new OmdiscardInstance(), rest: line.slice(1) };
}

export const omdiscard: OutputModule = {
  kind: 'output',
  name: 'omdiscard',
  builtin: true,
  parseSelector,
  newActionInstance(_params, context) {
    context.runtime.error(
      "config objects are not supported by module 'builtin:omdiscard' -- legacy config options MUST be used instead", RS_RET.CONFOBJ_UNSUPPORTED,
    );
    return null;
  },
};
