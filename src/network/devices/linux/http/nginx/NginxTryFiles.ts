import { unknownNginxVariable } from './NginxVariables';

export interface NginxTryEntry {
  readonly name: string;
  readonly testDir: boolean;
}

export type NginxTryFallback =
  | { readonly kind: 'code'; readonly code: number }
  | { readonly kind: 'uri'; readonly uri: string };

export interface NginxTryFiles {
  readonly entries: readonly NginxTryEntry[];
  readonly fallback: NginxTryFallback;
}

export interface NginxTryFilesDirective {
  readonly name: string;
  readonly args: readonly string[];
}

const MAX_CODE = 999;
const ALLOWED_PARENTS: readonly string[] = ['server', 'location'];

export function parseTryFiles(args: readonly string[]): NginxTryFiles | string {
  if (args.length < 2) return 'invalid number of arguments in "try_files" directive';
  const last = args[args.length - 1];
  const entries: NginxTryEntry[] = args.slice(0, -1).map((name) => (
    name.endsWith('/') ? { name: name.slice(0, -1), testDir: true } : { name, testDir: false }
  ));
  for (const arg of args) {
    const unknown = unknownNginxVariable(arg);
    if (unknown !== null) return `unknown "${unknown}" variable`;
  }
  if (!last.startsWith('=')) return { entries, fallback: { kind: 'uri', uri: last } };
  const digits = last.slice(1);
  const code = /^\d+$/.test(digits) ? Number(digits) : null;
  if (code === null || code > MAX_CODE) return `invalid code "${last}"`;
  return { entries, fallback: { kind: 'code', code } };
}

export function checkTryFilesDirective(
  args: readonly string[], alreadySet: boolean, parent: string | null,
): string | null {
  if (parent === null || !ALLOWED_PARENTS.includes(parent)) return '"try_files" directive is not allowed here';
  if (args.length < 2) return 'invalid number of arguments in "try_files" directive';
  if (alreadySet) return '"try_files" directive is duplicate';
  const parsed = parseTryFiles(args);
  return typeof parsed === 'string' ? parsed : null;
}

export function resolveTryFiles(
  parent: NginxTryFiles | undefined, own: readonly NginxTryFilesDirective[],
): NginxTryFiles | undefined {
  const directive = own.find((d) => d.name === 'try_files');
  if (directive === undefined) return parent;
  const parsed = parseTryFiles(directive.args);
  return typeof parsed === 'string' ? parent : parsed;
}
