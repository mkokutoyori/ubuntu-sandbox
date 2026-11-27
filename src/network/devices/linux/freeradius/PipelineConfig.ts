import type { ConfSection } from './FreeradiusConf';
import { parseStatements, moduleNames, UnlangError, type Statement } from './Unlang';

export type ProcessingSection = 'authorize' | 'authenticate' | 'preacct' | 'accounting' | 'session' | 'post-auth' | 'pre-proxy' | 'post-proxy';

export interface SectionLocation {
  readonly file: string;
  readonly line: number;
}

export interface AuthGroup {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly program: readonly Statement[];
}

export interface Pipeline {
  readonly sections: ReadonlyMap<ProcessingSection, ReadonlySet<string>>;
  readonly locations: ReadonlyMap<ProcessingSection, SectionLocation>;
  readonly authTypes: ReadonlyMap<string, SectionLocation>;
  readonly authorize: readonly Statement[] | null;
  readonly postAuth: readonly Statement[] | null;
  readonly preacct: readonly Statement[] | null;
  readonly accounting: readonly Statement[] | null;
  readonly preProxy: readonly Statement[] | null;
  readonly postProxy: readonly Statement[] | null;
  readonly authGroups: ReadonlyMap<string, AuthGroup>;
  readonly session: readonly Statement[] | null;
}

const SECTION_NAMES: readonly ProcessingSection[] = ['authorize', 'authenticate', 'preacct', 'accounting', 'session', 'post-auth', 'pre-proxy', 'post-proxy'];
const IMPLEMENTED_MODULES = new Set(['preprocess', 'chap', 'mschap', 'eap', 'files', 'pap', 'logintime', 'detail', 'radutmp', 'acct_unique', 'suffix', 'ntdomain', 'ok', 'noop', 'reject']);
const REAL_MODULES_NOT_IMPLEMENTED = new Set([
  'filter_username', 'digest', 'ntlm_auth', 'sql', 'ldap', 'expiration', 'unix', 'exec', 'attr_filter', 'linelog',
  'always', 'cache', 'passwd', 'perl', 'python', 'rest', 'sqlippool', 'radrelay', 'dhcp', 'counter', 'sradutmp', 'replicate', 'wimax',
  'krb5', 'pam', 'opendirectory', 'smbpasswd', 'etc_group', 'soh', 'sqlcounter', 'utf8', 'expr', 'date', 'delay', 'dynamic_clients',
  'echo', 'mac2ip', 'mac2vlan', 'ippool', 'ntlm', 'otp', 'smsotp', 'yubikey', 'fail', 'handled', 'invalid', 'notfound', 'reject_if_eap',
  'remove_reply_message_if_eap', 'reply_log', 'detail.log', 'detail.reply', 'control', 'cui', 'unpack',
]);
const REAL_UNLANG = new Set(['if', 'elsif', 'else', 'update', 'switch', 'case', 'foreach', 'redundant', 'load-balance', 'redundant-load-balance', 'group', 'return', 'break', 'map']);

function realmInstanceNames(root: ConfSection): ReadonlySet<string> {
  const modules = root.sections.find((section) => section.name1 === 'modules') ?? root;
  return new Set(modules.sections.filter((section) => section.name1 === 'realm' && section.name2 !== null).map((section) => section.name2 as string));
}

function sqlInstanceNames(root: ConfSection): ReadonlySet<string> {
  const modules = root.sections.find((section) => section.name1 === 'modules') ?? root;
  return new Set(modules.sections.filter((section) => section.name1 === 'sql').map((section) => section.name2 ?? section.name1));
}

export function readPipelines(root: ConfSection): Map<string, Pipeline> | { error: string } {
  const pipelines = new Map<string, Pipeline>();
  const realms = realmInstanceNames(root);
  const expansions = sqlInstanceNames(root);
  const resolve = (rawName: string, file: string, line: number): string | null => resolveModule(rawName, file, line, realms);
  const resolveWithSql = (rawName: string, file: string, line: number): string | null => {
    const name = rawName.startsWith('-') ? rawName.slice(1) : rawName;
    return expansions.has(name) ? name : resolve(rawName, file, line);
  };
  for (const server of root.sections.filter((section) => section.name1 === 'server')) {
    const sections = new Map<ProcessingSection, ReadonlySet<string>>();
    const locations = new Map<ProcessingSection, SectionLocation>();
    const authTypes = new Map<string, SectionLocation>();
    let authorize: Statement[] | null = null;
    let postAuth: Statement[] | null = null;
    let preacct: Statement[] | null = null;
    let accounting: Statement[] | null = null;
    const authGroups = new Map<string, AuthGroup>();
    let session: Statement[] | null = null;
    let preProxy: Statement[] | null = null;
    let postProxy: Statement[] | null = null;
    for (const section of server.sections) {
      if (!SECTION_NAMES.includes(section.name1 as ProcessingSection)) continue;
      locations.set(section.name1 as ProcessingSection, { file: section.file, line: section.line });
      if (section.name1 === 'authenticate') {
        for (const child of section.sections) if (child.name1 === 'Auth-Type' && child.name2 !== null) authTypes.set(child.name2, { file: child.file, line: child.line });
      }
      const names = new Set<string>();
      if (section.name1 === 'authorize' || section.name1 === 'post-auth' || section.name1 === 'preacct' || section.name1 === 'accounting' || section.name1 === 'pre-proxy' || section.name1 === 'post-proxy' || section.name1 === 'session') {
        let program: Statement[];
        try {
          const sqlSection = section.name1 === 'accounting' || section.name1 === 'authorize' || section.name1 === 'post-auth' || section.name1 === 'session';
          program = parseStatements(section, sqlSection ? resolveWithSql : resolve, false, expansions, expansions);
        } catch (error) {
          if (error instanceof UnlangError) return { error: error.message };
          throw error;
        }
        if (section.name1 === 'authorize') authorize = program;
        else if (section.name1 === 'post-auth') postAuth = program;
        else if (section.name1 === 'preacct') preacct = program;
        else if (section.name1 === 'session') session = program;
        else if (section.name1 === 'pre-proxy') preProxy = program;
        else if (section.name1 === 'post-proxy') postProxy = program;
        else accounting = program;
        moduleNames(program, names);
      } else if (section.name1 === 'authenticate') {
        const bare: ConfSection = { ...section, sections: [], items: [] };
        const failure = collectModules(bare, names, realms);
        if (failure !== null) return { error: failure };
        for (const child of section.sections) {
          if (child.name1 !== 'Auth-Type' || child.name2 === null) return { error: `${child.file}[${child.line}]: ${REAL_UNLANG.has(child.name1) ? `The unlang construct "${child.name1}" directly in authenticate is not implemented in this simulator` : `Unknown section "${child.name1}" in authenticate`}` };
          let program: Statement[];
          try {
            program = parseStatements(child, resolve, false, expansions);
          } catch (error) {
            if (error instanceof UnlangError) return { error: error.message };
            throw error;
          }
          moduleNames(program, names);
          authGroups.set(child.name2.toLowerCase(), { name: child.name2, file: child.file, line: child.line, program });
        }
      } else {
        const failure = collectModules(section, names, realms);
        if (failure !== null) return { error: failure };
      }
      sections.set(section.name1 as ProcessingSection, names);
    }
    pipelines.set(server.name2 ?? '', { sections, locations, authTypes, authorize, postAuth, preacct, accounting, preProxy, postProxy, authGroups, session });
  }
  return pipelines;
}

function resolveModule(rawName: string, file: string, line: number, realms: ReadonlySet<string>): string | null {
  const optional = rawName.startsWith('-');
  const name = optional ? rawName.slice(1) : rawName;
  const base = name.split('.')[0];
  if (IMPLEMENTED_MODULES.has(base)) return base;
  if (realms.has(name)) return name;
  if (optional) return null;
  if (REAL_MODULES_NOT_IMPLEMENTED.has(base) || REAL_MODULES_NOT_IMPLEMENTED.has(name)) {
    throw new UnlangError(`${file}[${line}]: The module "${name}" is not implemented in this simulator`);
  }
  throw new UnlangError(`${file}[${line}]: Failed to find module "${name}".`);
}

function collectModules(section: ConfSection, into: Set<string>, realms: ReadonlySet<string>): string | null {
  for (const pair of section.pairs) {
    if (pair.op !== '=' || pair.value !== '') return `${pair.file}[${pair.line}]: The unlang statement "${pair.name} ${pair.op} ${pair.value}" is not implemented in this simulator`;
    const optional = pair.name.startsWith('-');
    const name = optional ? pair.name.slice(1) : pair.name;
    const base = name.split('.')[0];
    if (IMPLEMENTED_MODULES.has(base)) into.add(base);
    else if (realms.has(name)) into.add(name);
    else if (optional) continue;
    else if (REAL_MODULES_NOT_IMPLEMENTED.has(base) || REAL_MODULES_NOT_IMPLEMENTED.has(name)) {
      return `${pair.file}[${pair.line}]: The module "${name}" is not implemented in this simulator`;
    } else return `${pair.file}[${pair.line}]: Failed to find module "${name}".`;
  }
  for (const child of section.sections) {
    if (REAL_UNLANG.has(child.name1)) return `${child.file}[${child.line}]: The unlang construct "${child.name1}" is not implemented in this simulator`;
    if (!child.name1.endsWith('-Type')) return `${child.file}[${child.line}]: Unknown section "${child.name1}" in ${section.name1}`;
    const failure = collectModules(child, into, realms);
    if (failure !== null) return failure;
  }
  return null;
}

export function pipelineAllows(pipeline: Pipeline | undefined, section: ProcessingSection, module: string): boolean {
  const names = pipeline?.sections.get(section);
  return names === undefined || names.has(module);
}
