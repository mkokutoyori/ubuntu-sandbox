import { PAM_RETURN_TOKENS, PAM_RETURN_VALUES } from './PamReturnCode';

export const PamAction = {
  IGNORE: 0,
  OK: -1,
  DONE: -2,
  BAD: -3,
  DIE: -4,
  RESET: -5,
  UNDEF: -6,
} as const;

export type PamActionTable = number[];

const ACTION_TOKENS: readonly string[] = ['ignore', 'ok', 'done', 'bad', 'die', 'reset'];

export function undefinedActions(): PamActionTable {
  return new Array<number>(PAM_RETURN_VALUES).fill(PamAction.UNDEF);
}

export function setDefaultControl(actions: PamActionTable, action: number): void {
  for (let index = 0; index < PAM_RETURN_VALUES; index++) {
    if (actions[index] === PamAction.UNDEF) actions[index] = action;
  }
}

export type SimpleControl = 'required' | 'requisite' | 'optional' | 'sufficient';

export function actionsForKeyword(keyword: SimpleControl): PamActionTable {
  const actions = undefinedActions();
  switch (keyword) {
    case 'required':
      actions[0] = PamAction.OK;
      actions[12] = PamAction.OK;
      actions[25] = PamAction.IGNORE;
      setDefaultControl(actions, PamAction.BAD);
      break;
    case 'requisite':
      actions[0] = PamAction.OK;
      actions[12] = PamAction.OK;
      actions[25] = PamAction.IGNORE;
      setDefaultControl(actions, PamAction.DIE);
      break;
    case 'optional':
      actions[0] = PamAction.OK;
      actions[12] = PamAction.OK;
      setDefaultControl(actions, PamAction.IGNORE);
      break;
    case 'sufficient':
      actions[0] = PamAction.DONE;
      actions[12] = PamAction.DONE;
      setDefaultControl(actions, PamAction.IGNORE);
      break;
  }
  return actions;
}

export interface ParsedControl {
  readonly actions: PamActionTable;
  readonly error: string | null;
}

export function parseBracketControl(token: string): ParsedControl {
  const actions = undefinedActions();
  const failure = (error: string): ParsedControl => ({
    actions: new Array<number>(PAM_RETURN_VALUES).fill(PamAction.BAD),
    error,
  });
  let rest = token;
  const skipSpaces = (): void => { rest = rest.replace(/^\s+/, ''); };
  for (;;) {
    skipSpaces();
    if (rest === '') break;
    let returnIndex = -1;
    for (let candidate = 0; candidate <= PAM_RETURN_VALUES; candidate++) {
      if (rest.startsWith(PAM_RETURN_TOKENS[candidate])) { returnIndex = candidate; break; }
    }
    if (returnIndex < 0) return failure('expecting return value');
    rest = rest.slice(PAM_RETURN_TOKENS[returnIndex].length);
    if (rest === '') return failure('expecting return value');
    skipSpaces();
    if (rest === '' || rest[0] !== '=') return failure("expecting '='");
    rest = rest.slice(1);
    skipSpaces();
    if (rest === '') return failure('expecting action');
    let action = 0;
    let matched = false;
    for (let candidate = 0; candidate < ACTION_TOKENS.length; candidate++) {
      if (rest.startsWith(ACTION_TOKENS[candidate])) {
        action = -candidate;
        rest = rest.slice(ACTION_TOKENS[candidate].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const digits = /^\d+/.exec(rest);
      if (digits === null) return failure('expecting jump number');
      action = Number.parseInt(digits[0], 10);
      rest = rest.slice(digits[0].length);
      if (action === 0) return failure('expecting non-zero');
    }
    if (returnIndex !== PAM_RETURN_VALUES) actions[returnIndex] = action;
    else setDefaultControl(actions, action);
  }
  setDefaultControl(actions, PamAction.BAD);
  return { actions, error: null };
}
