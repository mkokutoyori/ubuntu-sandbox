import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { SSH_DEFAULTS, type SshConfig } from '../../router/security/CiscoSecurityConfig';

export interface IpSshHost {
  sshConfig(): SshConfig;
  hasRsaKeys(): boolean;
  onAuthRetriesChanged(retries: number): void;
}

export const SSH_TIMEOUT_RANGE: readonly [number, number] = [1, 120];
export const SSH_RETRIES_RANGE: readonly [number, number] = [0, 5];

const VERSION: ArgumentSpec = {
  name: 'version', type: 'ENUM', description: 'SSH protocol version',
  values: [
    { keyword: '1', description: 'Accept SSH version 1 connections' },
    { keyword: '2', description: 'Accept SSH version 2 connections' },
  ],
};

const DELAI: ArgumentSpec = {
  name: 'secondes', type: 'INT', range: SSH_TIMEOUT_RANGE,
  description: 'SSH time-out interval in seconds',
};

const REESSAIS: ArgumentSpec = {
  name: 'reessais', type: 'INT', range: SSH_RETRIES_RANGE,
  description: 'Number of authentication retries',
};

const INTERFACE_SOURCE: ArgumentSpec = {
  name: 'interface', type: 'INTERFACE',
  description: 'Interface the SSH client sources from',
};

const TAILLE_DH: ArgumentSpec = {
  name: 'bits', type: 'ENUM', description: 'Minimum Diffie-Hellman key size',
  values: [
    { keyword: '1024', description: '1024-bit modulus' },
    { keyword: '2048', description: '2048-bit modulus' },
    { keyword: '4096', description: '4096-bit modulus' },
  ],
};

const FAMILLE_ALGO: ArgumentSpec = {
  name: 'famille', type: 'ENUM', description: 'Algorithm family to restrict',
  values: [
    { keyword: 'encryption', description: 'Encryption algorithms' },
    { keyword: 'kex', description: 'Key exchange algorithms' },
    { keyword: 'mac', description: 'Message authentication code algorithms' },
  ],
};

const LISTE_ALGO: ArgumentSpec = {
  name: 'liste', type: 'REST', description: 'Ordered list of algorithms',
};

const LISTES_PAR_FAMILLE: Readonly<Record<string, keyof SshConfig>> = {
  mac: 'macAlgorithms',
  encryption: 'encryptionAlgorithms',
  kex: 'kexAlgorithms',
};

export function ipSshSpecs(ctx: () => IpSshHost): CommandSpec[] {
  const specs: CommandSpec[] = [];

  const spec = (
    id: string, path: ReadonlyArray<string | ArgumentSpec>, description: string,
    run: CommandSpec['run'], undo: CommandSpec['undo'],
  ): CommandSpec => {
    const commun = {
      description,
      undoDescription: `Restore the default ${description.toLowerCase()}`,
      modes: ['config'] as const, minPrivilege: 15,
    };
    const derniere = path[path.length - 1];
    if (typeof derniere !== 'string' && derniere.optional !== true) {
      specs.push({
        ...commun,
        id: `config-ip-ssh-${id}-nue`,
        path: path.slice(0, -1) as CommandSpec['path'],
        existsOnlyNegated: true,
        run: () => '',
        undo,
      });
    }
    return { ...commun, id: `config-ip-ssh-${id}`, path: [...path], run, undo };
  };

  specs.push(
    spec('version', ['ip', 'ssh', 'version', VERSION], 'SSH protocol version to accept',
      (_session, args) => {
        const version = Number(args.version);
        if (!ctx().hasRsaKeys()) {
          return 'Please create RSA keys (of at least 768 bits size)'
            + ` to enable SSH v${version}.`;
        }
        ctx().sshConfig().version = version;
        return '';
      },
      () => { ctx().sshConfig().version = SSH_DEFAULTS.version; return ''; }),

    spec('time-out', ['ip', 'ssh', 'time-out', DELAI], 'Timeout interval',
      (_session, args) => {
        ctx().sshConfig().timeoutSec = Number(args.secondes);
        return '';
      },
      () => { ctx().sshConfig().timeoutSec = SSH_DEFAULTS.timeoutSec; return ''; }),

    spec('authentication-retries', ['ip', 'ssh', 'authentication-retries', REESSAIS],
      'Number of authentication retries',
      (_session, args) => {
        const retries = Number(args.reessais);
        ctx().sshConfig().authRetries = retries;
        ctx().onAuthRetriesChanged(retries);
        return '';
      },
      () => {
        ctx().sshConfig().authRetries = SSH_DEFAULTS.authRetries;
        ctx().onAuthRetriesChanged(SSH_DEFAULTS.authRetries);
        return '';
      }),

    spec('source-interface', ['ip', 'ssh', 'source-interface', INTERFACE_SOURCE],
      'Interface the SSH client sources from',
      (_session, args) => { ctx().sshConfig().sourceInterface = args.interface; return ''; },
      () => { delete ctx().sshConfig().sourceInterface; return ''; }),

    spec('dh-min-size', ['ip', 'ssh', 'dh', 'min', 'size', TAILLE_DH],
      'Diffie-Hellman key exchange parameters',
      (_session, args) => { ctx().sshConfig().dhMinBits = Number(args.bits); return ''; },
      () => { ctx().sshConfig().dhMinBits = SSH_DEFAULTS.dhMinBits; return ''; }),

    spec('logging-events', ['ip', 'ssh', 'logging', 'events'], 'Log SSH events',
      () => { ctx().sshConfig().loggingEvents = true; return ''; },
      () => { ctx().sshConfig().loggingEvents = false; return ''; }),

    spec('server-algorithm',
      ['ip', 'ssh', 'server', 'algorithm', FAMILLE_ALGO, LISTE_ALGO],
      'SSH server options',
      (_session, args) => {
        const champ = LISTES_PAR_FAMILLE[args.famille];
        (ctx().sshConfig() as unknown as Record<string, string[]>)[champ] =
          args.liste.trim().split(/\s+/).filter(Boolean);
        return '';
      },
      (_session, args) => {
        const champ = LISTES_PAR_FAMILLE[args.famille];
        (ctx().sshConfig() as unknown as Record<string, string[]>)[champ] = [];
        return '';
      }),

    spec('scp-server', ['ip', 'scp', 'server', 'enable'], 'Enable the SCP server',
      () => { ctx().sshConfig().scpServerEnabled = true; return ''; },
      () => { ctx().sshConfig().scpServerEnabled = false; return ''; }),
  );
  return specs;
}
