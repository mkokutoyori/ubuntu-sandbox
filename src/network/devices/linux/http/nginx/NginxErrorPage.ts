import { unknownNginxVariable } from './NginxVariables';

export interface NginxErrorPageRule {
  readonly status: number;
  readonly overwrite: number;
  readonly target: string;
}

export interface NginxErrorPageDirective {
  readonly name: string;
  readonly args: readonly string[];
}

export const KEEP_STATUS = -1;
export const REPLACEMENT_STATUS = 0;

const MIN_STATUS = 300;
const MAX_STATUS = 599;
const CLIENT_CLOSED = 499;
const TO_HTTPS_FAMILY: ReadonlySet<number> = new Set([494, 495, 496, 497]);
const ALLOWED_PARENTS: readonly string[] = ['http', 'server', 'location'];

export function parseErrorPage(args: readonly string[]): NginxErrorPageRule[] | string {
  if (args.length < 2) return 'invalid number of arguments in "error_page" directive';
  const target = args[args.length - 1];
  const marker = args[args.length - 2];
  let overwrite = KEEP_STATUS;
  let codeCount = args.length - 1;
  if (marker.startsWith('=')) {
    if (args.length === 2) return `invalid value "${marker}"`;
    if (marker.length > 1) {
      if (!/^\d+$/.test(marker.slice(1))) return `invalid value "${marker}"`;
      overwrite = Number(marker.slice(1));
    } else {
      overwrite = REPLACEMENT_STATUS;
    }
    codeCount = args.length - 2;
  }
  const unknown = unknownNginxVariable(target);
  if (unknown !== null) return `unknown "${unknown}" variable`;

  const rules: NginxErrorPageRule[] = [];
  for (const code of args.slice(0, codeCount)) {
    const status = /^\d+$/.test(code) ? Number(code) : null;
    if (status === null || status === CLIENT_CLOSED) return `invalid value "${code}"`;
    if (status < MIN_STATUS || status > MAX_STATUS) return `value "${code}" must be between ${MIN_STATUS} and ${MAX_STATUS}`;
    rules.push({ status, overwrite: overwrite === KEEP_STATUS && TO_HTTPS_FAMILY.has(status) ? 400 : overwrite, target });
  }
  return rules;
}

export function checkErrorPageDirective(args: readonly string[], parent: string | null): string | null {
  if (parent === null || !ALLOWED_PARENTS.includes(parent)) return '"error_page" directive is not allowed here';
  const parsed = parseErrorPage(args);
  return typeof parsed === 'string' ? parsed : null;
}

export function resolveErrorPages(
  parent: readonly NginxErrorPageRule[], own: readonly NginxErrorPageDirective[],
): readonly NginxErrorPageRule[] {
  const declared = own.filter((d) => d.name === 'error_page');
  if (declared.length === 0) return parent;
  const rules: NginxErrorPageRule[] = [];
  for (const directive of declared) {
    const parsed = parseErrorPage(directive.args);
    if (typeof parsed !== 'string') rules.push(...parsed);
  }
  return rules;
}

export function findErrorPage(rules: readonly NginxErrorPageRule[], status: number): NginxErrorPageRule | undefined {
  return rules.find((rule) => rule.status === status);
}
