import type { ConfSection } from './FreeradiusConf';

export type ProcessingSection = 'authorize' | 'authenticate' | 'preacct' | 'accounting' | 'session' | 'post-auth';

export interface SectionLocation {
  readonly file: string;
  readonly line: number;
}

export interface Pipeline {
  readonly sections: ReadonlyMap<ProcessingSection, ReadonlySet<string>>;
  readonly locations: ReadonlyMap<ProcessingSection, SectionLocation>;
  readonly authTypes: ReadonlyMap<string, SectionLocation>;
}

const SECTION_NAMES: readonly ProcessingSection[] = ['authorize', 'authenticate', 'preacct', 'accounting', 'session', 'post-auth'];
const IMPLEMENTED_MODULES = new Set(['preprocess', 'chap', 'mschap', 'eap', 'files', 'pap', 'logintime', 'detail', 'radutmp', 'acct_unique', 'ok', 'noop', 'reject']);
const REAL_MODULES_NOT_IMPLEMENTED = new Set([
  'filter_username', 'digest', 'suffix', 'realm', 'ntlm_auth', 'sql', 'ldap', 'expiration', 'unix', 'exec', 'attr_filter', 'linelog',
  'always', 'cache', 'passwd', 'perl', 'python', 'rest', 'sqlippool', 'radrelay', 'dhcp', 'counter', 'sradutmp', 'replicate', 'wimax',
  'krb5', 'pam', 'opendirectory', 'smbpasswd', 'etc_group', 'soh', 'sqlcounter', 'utf8', 'expr', 'date', 'delay', 'dynamic_clients',
  'echo', 'mac2ip', 'mac2vlan', 'ippool', 'ntlm', 'otp', 'smsotp', 'yubikey', 'fail', 'handled', 'invalid', 'notfound', 'reject_if_eap',
  'remove_reply_message_if_eap', 'reply_log', 'detail.log', 'detail.reply', 'control', 'cui', 'unpack',
]);
const REAL_UNLANG = new Set(['if', 'elsif', 'else', 'update', 'switch', 'case', 'foreach', 'redundant', 'load-balance', 'redundant-load-balance', 'group', 'return', 'break', 'map']);

export function readPipelines(root: ConfSection): Map<string, Pipeline> | { error: string } {
  const pipelines = new Map<string, Pipeline>();
  for (const server of root.sections.filter((section) => section.name1 === 'server')) {
    const sections = new Map<ProcessingSection, ReadonlySet<string>>();
    const locations = new Map<ProcessingSection, SectionLocation>();
    const authTypes = new Map<string, SectionLocation>();
    for (const section of server.sections) {
      if (!SECTION_NAMES.includes(section.name1 as ProcessingSection)) continue;
      locations.set(section.name1 as ProcessingSection, { file: section.file, line: section.line });
      if (section.name1 === 'authenticate') {
        for (const child of section.sections) if (child.name1 === 'Auth-Type' && child.name2 !== null) authTypes.set(child.name2, { file: child.file, line: child.line });
      }
      const names = new Set<string>();
      const failure = collectModules(section, names);
      if (failure !== null) return { error: failure };
      sections.set(section.name1 as ProcessingSection, names);
    }
    pipelines.set(server.name2 ?? '', { sections, locations, authTypes });
  }
  return pipelines;
}

function collectModules(section: ConfSection, into: Set<string>): string | null {
  for (const pair of section.pairs) {
    if (pair.op !== '=' || pair.value !== '') return `${pair.file}[${pair.line}]: The unlang statement "${pair.name} ${pair.op} ${pair.value}" is not implemented in this simulator`;
    const optional = pair.name.startsWith('-');
    const name = optional ? pair.name.slice(1) : pair.name;
    const base = name.split('.')[0];
    if (IMPLEMENTED_MODULES.has(base)) into.add(base);
    else if (optional) continue;
    else if (REAL_MODULES_NOT_IMPLEMENTED.has(base) || REAL_MODULES_NOT_IMPLEMENTED.has(name)) {
      return `${pair.file}[${pair.line}]: The module "${name}" is not implemented in this simulator`;
    } else return `${pair.file}[${pair.line}]: Failed to find module "${name}".`;
  }
  for (const child of section.sections) {
    if (REAL_UNLANG.has(child.name1)) return `${child.file}[${child.line}]: The unlang construct "${child.name1}" is not implemented in this simulator`;
    if (!child.name1.endsWith('-Type')) return `${child.file}[${child.line}]: Unknown section "${child.name1}" in ${section.name1}`;
    const failure = collectModules(child, into);
    if (failure !== null) return failure;
  }
  return null;
}

export function pipelineAllows(pipeline: Pipeline | undefined, section: ProcessingSection, module: string): boolean {
  const names = pipeline?.sections.get(section);
  return names === undefined || names.has(module);
}
