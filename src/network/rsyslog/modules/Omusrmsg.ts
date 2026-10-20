import type { NvList } from '../config/Ast';
import { getParams, numberParam, reportUnused, stringParam, type ParamDescriptor } from '../config/Params';
import { RS_RET } from '../engine/Log';
import { parseSelectorTemplate } from './SelectorTemplate';
import type {
  ActionArguments, ActionModuleInstance, ActionWorker, ModuleContext, ModuleRateLimiter, OutputModule, SelectorParse, TemplateRequest,
} from '../engine/Modules';

const MAX_USERS = 20;
const USER_NAME_SIZE = 32;

const ACTION_PARAMS: readonly ParamDescriptor[] = [
  { name: 'users', type: 'string', required: true }, { name: 'template', type: 'word' }, { name: 'ratelimit.interval', type: 'int' },
  { name: 'ratelimit.burst', type: 'int' }, { name: 'ratelimit.name', type: 'string' },
];

function populateUsers(text: string): string[] {
  return text.split(',').map((name) => name.trim().slice(0, USER_NAME_SIZE)).filter((name) => name.length > 0).slice(0, MAX_USERS);
}

class OmusrmsgInstance implements ActionModuleInstance {
  readonly moduleName = 'omusrmsg';
  readonly templates: TemplateRequest[];
  readonly description: string;

  constructor(
    private readonly wall: boolean,
    private readonly users: string[],
    templateName: string,
    private readonly limiter: ModuleRateLimiter | null,
    private readonly context: ModuleContext,
  ) {
    this.templates = [{ name: templateName }];
    this.description = wall ? '*' : users.join(',');
  }

  deliver(text: string): void {
    if (this.limiter !== null && !this.limiter.admit('omusrmsg')) return;
    const users = this.context.host.users;
    if (this.wall) {
      for (const entry of users.allLoggedInTerminals()) entry.sink.write(text);
      return;
    }
    for (const user of this.users) for (const sink of users.loggedInTerminals(user)) sink.write(text);
  }

  createWorker(): ActionWorker {
    return {
      doAction: (args: ActionArguments) => {
        this.deliver(args.strings[0] ?? '');
        return 'ok';
      },
      close: () => undefined,
    };
  }
}

function parseSelector(line: string, context: ModuleContext): SelectorParse {
  let rest = line;
  let warning: string | undefined;
  if (rest.startsWith(':omusrmsg:')) {
    rest = rest.slice(':omusrmsg:'.length);
  } else if (rest.length === 0 || !/[A-Za-z0-9_.*]/.test(rest[0])) {
    return { status: 'unprocessed' };
  } else {
    warning = `action '${rest}' treated as ':omusrmsg:${rest}' - please use ':omusrmsg:${rest}' syntax instead, '${rest}' will not be supported in the future`;
  }
  if (rest.startsWith('*')) {
    const template = parseSelectorTemplate(rest.slice(1), ' WallFmt', context.runtime);
    if (template === null) return { status: 'error' };
    return { status: 'ok', instance: new OmusrmsgInstance(true, [], template, null, context), rest: '', warning };
  }
  const semicolon = rest.indexOf(';');
  const names = semicolon < 0 ? rest : rest.slice(0, semicolon);
  const template = parseSelectorTemplate(semicolon < 0 ? '' : rest.slice(semicolon), ' StdUsrMsgFmt', context.runtime);
  if (template === null) return { status: 'error' };
  return { status: 'ok', instance: new OmusrmsgInstance(false, populateUsers(names), template, null, context), rest: '', warning };
}

function newActionInstance(params: NvList, context: ModuleContext): ActionModuleInstance | null {
  const values = getParams(params, ACTION_PARAMS, {
    report: (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR),
    uidOf: () => null,
    gidOf: () => null,
  });
  if (values === null) return null;
  reportUnused(params, (message) => context.runtime.error(message, RS_RET.CONF_PARSE_ERROR));
  const users = stringParam(values, 'users') ?? '';
  const wall = users === '*';
  const interval = numberParam(values, 'ratelimit.interval') ?? -1;
  const burst = numberParam(values, 'ratelimit.burst') ?? -1;
  const rateName = stringParam(values, 'ratelimit.name');
  let effectiveInterval = interval;
  let effectiveBurst = burst;
  if (rateName !== undefined) {
    if (interval !== -1 || burst !== -1) {
      context.runtime.error('omusrmsg: ratelimit.name is mutually exclusive with ratelimit.interval and ratelimit.burst - using ratelimit.name', RS_RET.ERR);
    }
    effectiveInterval = 0;
    effectiveBurst = 0;
  } else {
    if (effectiveInterval === -1) effectiveInterval = 0;
    if (effectiveBurst === -1) effectiveBurst = 200;
  }
  const template = stringParam(values, 'template') ?? (wall ? ' WallFmt' : ' StdUsrMsgFmt');
  const created = context.rateLimiter({ module: 'omusrmsg', interval: effectiveInterval, burst: effectiveBurst, configName: rateName ?? null });
  if (created === null) return null;
  return new OmusrmsgInstance(wall, wall ? [] : populateUsers(users), template, created.limiter, context);
}

export const omusrmsg: OutputModule = {
  kind: 'output',
  name: 'omusrmsg',
  builtin: true,
  parseSelector,
  newActionInstance,
};
