export interface Krb5Principal {
  readonly realm: string;
  readonly components: readonly string[];
  readonly nameType: number;
}

export const KRB5_NT_PRINCIPAL = 1;
export const KRB5_NT_SRV_INST = 2;
export const KRB5_NT_SRV_HST = 3;
export const KRB5_NT_ENTERPRISE_PRINCIPAL = 10;

export type ParseNameResult =
  | { readonly ok: true; readonly principal: Krb5Principal }
  | { readonly ok: false; readonly message: string };

const MALFORMED_PRINCIPAL = 'Malformed representation of principal';
const NO_DEFAULT_REALM = 'Configuration file does not specify default realm';
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', b: '\b', '0': '\0' };

export function parsePrincipalName(name: string, defaultRealm: string | null): ParseNameResult {
  const components: string[] = [];
  let current = '';
  let realm: string | null = null;
  let index = 0;
  while (index < name.length) {
    const character = name[index];
    if (character === '\\') {
      index++;
      if (index >= name.length) return { ok: false, message: MALFORMED_PRINCIPAL };
      current += ESCAPES[name[index]] ?? name[index];
    } else if (character === '/' && realm === null) {
      components.push(current);
      current = '';
    } else if (character === '@') {
      if (realm !== null) return { ok: false, message: MALFORMED_PRINCIPAL };
      components.push(current);
      current = '';
      realm = '';
    } else if (realm !== null) {
      realm += character;
    } else {
      current += character;
    }
    index++;
  }
  if (realm === null) components.push(current);
  else if (realm === '' && defaultRealm === null) return { ok: false, message: NO_DEFAULT_REALM };
  const resolved = realm !== null && realm !== '' ? realm : defaultRealm;
  if (resolved === null) return { ok: false, message: NO_DEFAULT_REALM };
  return { ok: true, principal: { realm: resolved, components, nameType: KRB5_NT_PRINCIPAL } };
}

function escapeComponent(component: string, escapeAt: boolean): string {
  let out = '';
  for (const character of component) {
    if (character === '\\') out += '\\\\';
    else if (character === '/') out += '\\/';
    else if (character === '@' && escapeAt) out += '\\@';
    else if (character === '\n') out += '\\n';
    else if (character === '\t') out += '\\t';
    else if (character === '\b') out += '\\b';
    else if (character === '\0') out += '\\0';
    else out += character;
  }
  return out;
}

export function unparsePrincipal(principal: Krb5Principal, omitRealm = false): string {
  const enterprise = principal.nameType === KRB5_NT_ENTERPRISE_PRINCIPAL;
  const body = principal.components.map((component) => escapeComponent(component, !enterprise)).join('/');
  return omitRealm ? body : `${body}@${escapeComponent(principal.realm, true)}`;
}

export function samePrincipal(left: Krb5Principal, right: Krb5Principal): boolean {
  return left.realm === right.realm && left.components.length === right.components.length
    && left.components.every((component, index) => component === right.components[index]);
}
