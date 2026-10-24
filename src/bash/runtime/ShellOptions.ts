import type { Environment } from './Environment';

function names(value: string | undefined): string[] {
  return (value ?? '').split(':').filter(Boolean);
}

export function isShellOptionEnabled(env: Environment, name: string): boolean {
  return names(env.get('SHELLOPTS')).includes(name) || names(env.get('BASHOPTS')).includes(name);
}
