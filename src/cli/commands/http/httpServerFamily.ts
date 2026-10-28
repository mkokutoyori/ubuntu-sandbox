import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export interface HttpServerHost {
  setEnabled(on: boolean): void;
  setSecureEnabled(on: boolean): void;
  setPort(port: number): void;
  setSecurePort(port: number): void;
  authentication(words: readonly string[]): void;
  resetAuthentication(): void;
  maxConnections(words: readonly string[]): void;
  resetMaxConnections(): void;
  accessClass(words: readonly string[]): void;
  clearAccessClass(): void;
  timeoutPolicy(words: readonly string[]): void;
  resetTimeoutPolicy(): void;
}

const words = (value: string | undefined): string[] =>
  (value ?? '').trim().split(/\s+/).filter(Boolean);

function port(description: string): ArgumentSpec {
  return { name: 'port', type: 'INT', description, range: [1, 65535] };
}

function free(name: string, description: string): ArgumentSpec {
  return { name, type: 'REST', description };
}

const ACCESS_LIST: ArgumentSpec = {
  ...free('list', 'Access list restricting who may connect'),
  alternatives: [
    { keyword: 'WORD', description: 'Access list name or number' },
    { keyword: 'ipv4', description: 'IPv4 access list, then its name' },
  ],
};

export function httpServerFamily(host: () => HttpServerHost): CommandSpec[] {
  const base = { modes: ['config'], minPrivilege: 15 };
  const flag = (
    keyword: string, description: string, set: (on: boolean) => void,
  ): CommandSpec => ({
    ...base, id: `ip-http-${keyword}`, path: ['ip', 'http', keyword], description,
    run: () => { set(true); return ''; },
    undo: () => { set(false); return ''; },
  });
  const valued = (
    keyword: string, place: ArgumentSpec, description: string,
    run: (value: string) => void, reset: (() => void) | null,
  ): CommandSpec[] => [
    {
      ...base, id: `ip-http-${keyword}`, path: ['ip', 'http', keyword, place], description,
      run: (_session, args) => { run(args[place.name]); return ''; },
      ...(reset ? { undo: () => { reset(); return ''; } } : {}),
    },
    ...(reset ? [{
      ...base, id: `ip-http-${keyword}-undo`, path: ['ip', 'http', keyword], description,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => { reset(); return ''; },
    } as CommandSpec] : []),
  ];
  return [
    flag('server', 'Enable HTTP server', (on) => host().setEnabled(on)),
    flag('secure-server', 'Enable HTTPS server', (on) => host().setSecureEnabled(on)),
    ...valued('port', port('Port the HTTP server listens on'), 'HTTP server port',
      (value) => host().setPort(Number(value)), () => host().setPort(80)),
    ...valued('secure-port', port('Port the HTTPS server listens on'), 'HTTPS server port',
      (value) => host().setSecurePort(Number(value)), null),
    ...valued('authentication', free('method', 'How the server authenticates a request'),
      'Set HTTP server authentication method',
      (value) => host().authentication(words(value)), () => host().resetAuthentication()),
    ...valued('max-connections', free('count', 'Number of concurrent connections allowed'),
      'Set maximum concurrent connections',
      (value) => host().maxConnections(words(value)), () => host().resetMaxConnections()),
    ...valued('access-class', ACCESS_LIST, 'Restrict HTTP server access by ACL',
      (value) => host().accessClass(words(value)), () => host().clearAccessClass()),
    ...valued('timeout-policy',
      free('policy', '`idle`, `life` and `requests`, with their values'),
      'Set HTTP server timeout policy',
      (value) => host().timeoutPolicy(words(value)), () => host().resetTimeoutPolicy()),
  ];
}
