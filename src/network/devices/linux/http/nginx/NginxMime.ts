import { unknownNginxVariable } from './NginxVariables';

export interface NginxMimeDirective {
  readonly name: string;
  readonly args: readonly string[];
  readonly block?: readonly NginxMimeDirective[];
}

export interface NginxContentTypes {
  readonly types: ReadonlyMap<string, string>;
  readonly defaultType: string;
}

export const DEFAULT_CONTENT_TYPES: NginxContentTypes = Object.freeze({
  types: new Map([['html', 'text/html']]),
  defaultType: 'text/plain',
});

export const NGINX_MIME_DIRECTIVES: ReadonlySet<string> = new Set(['default_type', 'types']);

const ALLOWED_PARENTS: readonly string[] = ['http', 'server', 'location'];

export function checkMimeDirective(
  name: string, args: readonly string[], alreadySet: boolean, parent: string | null,
): string | null {
  if (parent === null || !ALLOWED_PARENTS.includes(parent)) return `"${name}" directive is not allowed here`;
  if (name === 'default_type') {
    if (args.length !== 1) return 'invalid number of arguments in "default_type" directive';
    if (alreadySet) return '"default_type" directive is duplicate';
    const unknown = unknownNginxVariable(args[0]);
    return unknown === null ? null : `unknown "${unknown}" variable`;
  }
  return args.length === 0 ? null : 'invalid number of arguments in "types" directive';
}

export function checkTypesEntry(args: readonly string[], name: string): string | null {
  return args.length === 0 ? `invalid number of arguments in "${name}" directive` : null;
}

export function resolveContentTypes(
  parent: NginxContentTypes, own: readonly NginxMimeDirective[],
): NginxContentTypes {
  if (own.length === 0) return parent;
  let types = parent.types;
  let defaultType = parent.defaultType;
  let typesDeclared = false;
  for (const directive of own) {
    if (directive.name === 'default_type') {
      defaultType = directive.args[0];
      continue;
    }
    if (directive.name !== 'types') continue;
    const merged = typesDeclared ? new Map(types) : new Map<string, string>();
    for (const entry of directive.block ?? []) {
      for (const extension of entry.args) merged.set(extension.toLowerCase(), entry.name.toLowerCase());
    }
    types = merged;
    typesDeclared = true;
  }
  return { types, defaultType };
}

export function contentTypeFor(contentTypes: NginxContentTypes, path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot > slash && dot < path.length - 1) {
    const found = contentTypes.types.get(path.slice(dot + 1).toLowerCase());
    if (found !== undefined) return found;
  }
  return contentTypes.defaultType;
}
