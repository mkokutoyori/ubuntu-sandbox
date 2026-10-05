import {
  type PamActionTable,
  PamAction,
  actionsForKeyword,
  parseBracketControl,
  setDefaultControl,
  undefinedActions,
} from './PamControl';

export type PamModuleType = 'auth' | 'account' | 'password' | 'session';

export type PamHandlerKind = 'module' | 'silent-module' | 'must-fail' | 'substack';

export interface PamFrozenChain {
  value: number;
}

export interface PamHandler {
  readonly moduleType: PamModuleType;
  readonly kind: PamHandlerKind;
  readonly stackLevel: number;
  readonly module: string | null;
  readonly args: readonly string[];
  readonly actions: PamActionTable;
  readonly frozen: PamFrozenChain;
  readonly source: string;
}

export type PamStacks = Readonly<Record<PamModuleType, readonly PamHandler[]>>;

export interface PamFileSource {
  readFile(path: string): string | null;
}

export interface LoadedPamStacks {
  readonly stacks: PamStacks;
  readonly service: string;
  readonly diagnostics: readonly string[];
}

export const PAM_DIRECTORY = '/etc/pam.d';
export const PAM_DEFAULT_SERVICE = 'other';
export const PAM_INVALID_RETVAL = -1;

const MAX_SUBSTACK_LEVEL = 16;
const MAX_INCLUDE_DEPTH = 64;

export function assemblePamLines(content: string): string[] {
  const lines: string[] = [];
  let pending = '';
  for (const physical of content.split('\n')) {
    const trimmedStart = physical.replace(/^[ \t\n]+/, '');
    if (trimmedStart === '' || trimmedStart.startsWith('#')) continue;
    const hash = trimmedStart.indexOf('#');
    if (hash >= 0) {
      lines.push(pending + trimmedStart.slice(0, hash));
      pending = '';
      continue;
    }
    const trimmedEnd = trimmedStart.replace(/[ \t\n]+$/, '');
    if (trimmedEnd.endsWith('\\')) {
      pending += `${trimmedEnd.slice(0, -1)} `;
      continue;
    }
    lines.push(pending + trimmedStart);
    pending = '';
  }
  return lines;
}

export function tokenizePamLine(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /[ \t\n]/.test(text[index])) index++;
    if (index >= text.length) break;
    if (text[index] === '[') {
      index++;
      let token = '';
      while (index < text.length && text[index] !== ']') {
        if (text[index] === '\\' && text[index + 1] === ']') index++;
        token += text[index];
        index++;
      }
      index++;
      tokens.push(token);
    } else {
      let token = '';
      while (index < text.length && !/[ \t\n]/.test(text[index])) { token += text[index]; index++; }
      tokens.push(token);
    }
  }
  return tokens;
}

export function pamModuleName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(0, dot) : base;
}

const MODULE_TYPES: Readonly<Record<string, PamModuleType>> = {
  auth: 'auth', session: 'session', account: 'account', password: 'password',
};

class StackBuilder {
  readonly stacks: Record<PamModuleType, PamHandler[]> = { auth: [], account: [], password: [], session: [] };
  readonly diagnostics: string[] = [];

  constructor(private readonly source: PamFileSource, private readonly directory: string) {}

  loadFile(name: string, requested: PamModuleType | null, stackLevel: number, depth: number, knownService: string): boolean {
    if (stackLevel >= MAX_SUBSTACK_LEVEL) {
      this.diagnostics.push('maximum level of substacks reached');
      return false;
    }
    if (depth > MAX_INCLUDE_DEPTH) {
      this.diagnostics.push('maximum level of includes reached');
      return false;
    }
    const path = name.startsWith('/') ? name : `${this.directory}/${name}`;
    const content = this.source.readFile(path);
    if (content === null) {
      this.diagnostics.push(`_pam_load_conf_file: unable to open config for ${name}`);
      return false;
    }
    for (const line of assemblePamLines(content)) this.parseLine(line, requested, stackLevel, depth, knownService, path);
    return true;
  }

  private add(
    moduleType: PamModuleType, kind: PamHandlerKind, stackLevel: number, modulePath: string | null,
    args: readonly string[], actions: PamActionTable, source: string,
  ): void {
    this.stacks[moduleType].push({
      moduleType, kind, stackLevel,
      module: modulePath === null ? null : pamModuleName(modulePath),
      args, actions, frozen: { value: PAM_INVALID_RETVAL }, source,
    });
  }

  private parseLine(
    line: string, requested: PamModuleType | null, stackLevel: number, depth: number, knownService: string, source: string,
  ): void {
    const tokens = tokenizePamLine(line);
    if (tokens.length === 0) return;
    if (tokens[0] === '@include') {
      if (tokens[1] !== undefined) this.loadFile(tokens[1], null, stackLevel, depth + 1, knownService);
      return;
    }
    let kind: PamHandlerKind = 'module';
    let typeToken = tokens[0];
    let moduleType: PamModuleType;
    if (typeToken.startsWith('-')) {
      kind = 'silent-module';
      typeToken = typeToken.slice(1);
    }
    const known = MODULE_TYPES[typeToken.toLowerCase()];
    if (known === undefined) {
      this.diagnostics.push(`(${knownService}) illegal module type: ${typeToken}`);
      moduleType = requested ?? 'auth';
      kind = 'must-fail';
    } else {
      moduleType = known;
    }
    if (requested !== null && moduleType !== requested) return;

    let actions = undefinedActions();
    const controlToken = tokens[1];
    let include = false;
    let substack = false;
    if (controlToken === undefined) {
      this.diagnostics.push(`(${knownService}) no control flag supplied`);
      setDefaultControl(actions, PamAction.BAD);
      kind = 'must-fail';
    } else {
      const keyword = controlToken.toLowerCase();
      if (keyword === 'required' || keyword === 'requisite' || keyword === 'optional' || keyword === 'sufficient') {
        actions = actionsForKeyword(keyword);
      } else if (keyword === 'include') {
        include = true;
      } else if (keyword === 'substack') {
        include = true;
        substack = true;
      } else {
        const parsed = parseBracketControl(controlToken);
        if (parsed.error !== null) this.diagnostics.push(`pam_parse: ${parsed.error}; [...${controlToken}]`);
        actions = parsed.actions;
      }
    }

    const target = tokens[2];
    if (include) {
      if (target === undefined) {
        this.diagnostics.push(`(${knownService}) no module name supplied`);
        setDefaultControl(actions, PamAction.BAD);
        this.add(moduleType, 'must-fail', stackLevel, null, [], actions, source);
        return;
      }
      if (substack) this.add(moduleType, 'substack', stackLevel, target, [], actions, source);
      if (this.loadFile(target, moduleType, stackLevel + (substack ? 1 : 0), depth + 1, knownService)) return;
      setDefaultControl(actions, PamAction.BAD);
      this.add(moduleType, 'must-fail', stackLevel, null, [], actions, source);
      return;
    }
    if (target === undefined) {
      this.diagnostics.push(`(${knownService}) no module name supplied`);
      this.add(moduleType, 'must-fail', stackLevel, null, [], actions, source);
      return;
    }
    this.add(moduleType, kind, stackLevel, target, tokens.slice(3), actions, source);
  }
}

export function loadPamStacks(service: string, source: PamFileSource, directory = PAM_DIRECTORY): LoadedPamStacks {
  const builder = new StackBuilder(source, directory);
  const loaded = source.readFile(`${directory}/${service}`) !== null ? service : PAM_DEFAULT_SERVICE;
  if (!builder.loadFile(loaded, null, 0, 0, loaded)) {
    builder.diagnostics.push('_pam_init_handlers: could not open configuration');
  }
  return { stacks: builder.stacks, service: loaded, diagnostics: builder.diagnostics };
}
