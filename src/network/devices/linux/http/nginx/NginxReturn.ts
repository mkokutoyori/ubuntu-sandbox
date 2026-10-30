import { unknownNginxVariable } from './NginxVariables';

export interface NginxReturnRule {
  readonly status: number;
  readonly text: string | null;
}

const MAX_STATUS = 999;
const URL_START = /^(https?:\/\/|\$scheme)/;

export function parseReturn(args: readonly string[]): NginxReturnRule | string {
  if (args.length < 1 || args.length > 2) return 'invalid number of arguments in "return" directive';
  const code = /^\d+$/.test(args[0]) ? Number(args[0]) : null;
  if (code === null) {
    if (args.length === 1 && URL_START.test(args[0])) return checked({ status: 302, text: args[0] });
    return `invalid return code "${args[0]}"`;
  }
  if (code > MAX_STATUS) return `invalid return code "${args[0]}"`;
  return checked({ status: code, text: args.length === 2 ? args[1] : null });
}

function checked(rule: NginxReturnRule): NginxReturnRule | string {
  if (rule.text === null) return rule;
  const unknown = unknownNginxVariable(rule.text);
  return unknown === null ? rule : `unknown "${unknown}" variable`;
}
