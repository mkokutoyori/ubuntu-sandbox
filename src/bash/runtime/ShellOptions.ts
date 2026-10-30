import type { Environment } from './Environment';

export interface SetOption {
  readonly name: string;
  readonly letter?: string;
}

export const SET_OPTIONS: readonly SetOption[] = [
  { name: 'allexport', letter: 'a' },
  { name: 'braceexpand', letter: 'B' },
  { name: 'emacs' },
  { name: 'errexit', letter: 'e' },
  { name: 'errtrace', letter: 'E' },
  { name: 'functrace', letter: 'T' },
  { name: 'hashall', letter: 'h' },
  { name: 'histexpand', letter: 'H' },
  { name: 'history' },
  { name: 'ignoreeof' },
  { name: 'interactive-comments' },
  { name: 'keyword', letter: 'k' },
  { name: 'monitor', letter: 'm' },
  { name: 'noclobber', letter: 'C' },
  { name: 'noexec', letter: 'n' },
  { name: 'noglob', letter: 'f' },
  { name: 'nolog' },
  { name: 'notify', letter: 'b' },
  { name: 'nounset', letter: 'u' },
  { name: 'onecmd', letter: 't' },
  { name: 'physical', letter: 'P' },
  { name: 'pipefail' },
  { name: 'posix' },
  { name: 'privileged', letter: 'p' },
  { name: 'verbose', letter: 'v' },
  { name: 'vi' },
  { name: 'xtrace', letter: 'x' },
];

export const SHOPT_OPTIONS: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }> = [
  'autocd', 'assoc_expand_once', 'cdable_vars', 'cdspell', 'checkhash', 'checkjobs', 'checkwinsize', 'cmdhist',
  'compat31', 'compat32', 'compat40', 'compat41', 'compat42', 'compat43', 'compat44', 'complete_fullquote', 'direxpand',
  'dirspell', 'dotglob', 'execfail', 'expand_aliases', 'extdebug', 'extglob', 'extquote', 'failglob', 'force_fignore',
  'globasciiranges', 'globskipdots', 'globstar', 'gnu_errfmt', 'histappend', 'histreedit', 'histverify', 'hostcomplete',
  'huponexit', 'inherit_errexit', 'interactive_comments', 'lastpipe', 'lithist', 'localvar_inherit', 'localvar_unset',
  'login_shell', 'mailwarn', 'no_empty_cmd_completion', 'nocaseglob', 'nocasematch', 'noexpand_translation', 'nullglob',
  'patsub_replacement', 'progcomp', 'progcomp_alias', 'promptvars', 'restricted_shell', 'shift_verbose', 'sourcepath',
  'varredir_close', 'xpg_echo',
].map((name) => ({
  name,
  enabled: ['checkwinsize', 'cmdhist', 'complete_fullquote', 'extquote', 'force_fignore', 'globasciiranges', 'globskipdots',
    'hostcomplete', 'interactive_comments', 'patsub_replacement', 'progcomp', 'promptvars', 'sourcepath'].includes(name),
}));

const DEFAULT_SET_OPTIONS = ['braceexpand', 'hashall', 'interactive-comments'];

function names(value: string | undefined): string[] {
  return (value ?? '').split(':').filter(Boolean);
}

export function initializeShellOptions(env: Environment, interactive: boolean): void {
  if (env.get('SHELLOPTS') === undefined) env.set('SHELLOPTS', DEFAULT_SET_OPTIONS.join(':'));
  if (env.get('BASHOPTS') === undefined) {
    const enabled = SHOPT_OPTIONS.filter((option) => option.enabled).map((option) => option.name);
    if (interactive) enabled.push('expand_aliases');
    env.set('BASHOPTS', enabled.sort().join(':'));
  }
}

export function isShellOptionEnabled(env: Environment, name: string): boolean {
  return names(env.get('SHELLOPTS')).includes(name) || names(env.get('BASHOPTS')).includes(name);
}

export function setShellOption(env: Environment, variable: 'SHELLOPTS' | 'BASHOPTS', name: string, enable: boolean): void {
  const enabled = new Set(names(env.get(variable)));
  if (enable) enabled.add(name);
  else enabled.delete(name);
  env.set(variable, [...enabled].sort().join(':'));
}

export function optionFlags(env: Environment, interactive: boolean): string {
  const enabled = names(env.get('SHELLOPTS'));
  const letters = SET_OPTIONS.filter((option) => option.letter !== undefined && enabled.includes(option.name)).map((option) => option.letter as string);
  const order = 'abefhkmnptuvxBCEHPT';
  const sorted = letters.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('');
  return interactive ? `${sorted}i` : sorted;
}
