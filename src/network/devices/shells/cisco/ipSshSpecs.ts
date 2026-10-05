import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { SSH_DEFAULTS, type SshConfig } from '../../router/security/CiscoSecurityConfig';
import {
  IOS_ALGORITHM_VALUES, iosSshDefaults, type IosSshAlgorithmFamily,
} from '../../router/security/CiscoSshAlgorithms';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import type { CiscoSoftwareIdentity } from './CiscoPlatform';

export interface IpSshHost {
  sshConfig(): SshConfig;
  hasRsaKeys(): boolean;
  software(): CiscoSoftwareIdentity;
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

type CoteSsh = 'server' | 'client';

const LISTES_PAR_COTE: Readonly<Record<CoteSsh, Partial<Record<IosSshAlgorithmFamily, keyof SshConfig>>>> = {
  server: {
    mac: 'macAlgorithms', encryption: 'encryptionAlgorithms', kex: 'kexAlgorithms', hostkey: 'hostKeyAlgorithms',
  },
  client: { mac: 'clientMacAlgorithms', encryption: 'clientEncryptionAlgorithms' },
};

const FAMILLES_PAR_COTE: Readonly<Record<CoteSsh, readonly IosSshAlgorithmFamily[]>> = {
  server: ['encryption', 'hostkey', 'kex', 'mac'],
  client: ['encryption', 'mac'],
};

const DESCRIPTION_FAMILLE: Readonly<Record<IosSshAlgorithmFamily, string>> = {
  encryption: 'Encryption algorithms',
  hostkey: 'Host key algorithms',
  kex: 'Key exchange algorithms',
  mac: 'Message authentication code algorithms',
};

const LISTE_FAMILLE = (famille: IosSshAlgorithmFamily): ArgumentSpec => ({
  name: 'liste', type: 'REST', description: 'Ordered list of algorithms',
  values: IOS_ALGORITHM_VALUES[famille].map((keyword) => ({ keyword, description: keyword })),
});

function listeSaisie(famille: IosSshAlgorithmFamily, saisie: string): string[] {
  const noms = saisie.trim().split(/\s+/).filter(Boolean);
  const inconnu = noms.find((nom) => !IOS_ALGORITHM_VALUES[famille].includes(nom));
  if (inconnu !== undefined) throw new CliInvalidInput({ token: inconnu });
  return noms.filter((nom, i) => noms.indexOf(nom) === i);
}

function reglerListe(ssh: SshConfig, cote: CoteSsh, famille: IosSshAlgorithmFamily, liste: string[]): void {
  (ssh as unknown as Record<string, string[]>)[LISTES_PAR_COTE[cote][famille]!] = liste;
}

function listeEffective(host: IpSshHost, cote: CoteSsh, famille: IosSshAlgorithmFamily): readonly string[] {
  const configuree = (host.sshConfig() as unknown as Record<string, string[]>)[LISTES_PAR_COTE[cote][famille]!];
  return configuree.length > 0 ? configuree : iosSshDefaults(host.software())[famille];
}

function retirerDeLaListe(
  host: IpSshHost, cote: CoteSsh, famille: IosSshAlgorithmFamily, retires: readonly string[],
): string {
  const restant = listeEffective(host, cote, famille).filter((nom) => !retires.includes(nom));
  if (restant.length === 0) return `% SSH command rejected: All ${famille} algorithms cannot be disabled`;
  reglerListe(host.sshConfig(), cote, famille, restant);
  return '';
}

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
      (_session, args) => { ctx().sshConfig().authRetries = Number(args.reessais); return ''; },
      () => { ctx().sshConfig().authRetries = SSH_DEFAULTS.authRetries; return ''; }),

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

    ...(['server', 'client'] as const).flatMap((cote) => FAMILLES_PAR_COTE[cote].map((famille) => spec(
      `${cote}-algorithm-${famille}`,
      ['ip', 'ssh', cote, 'algorithm', famille, LISTE_FAMILLE(famille)],
      DESCRIPTION_FAMILLE[famille],
      (_session, args) => {
        reglerListe(ctx().sshConfig(), cote, famille, listeSaisie(famille, args.liste));
        return '';
      },
      (_session, args) => {
        const retires = listeSaisie(famille, args.liste ?? '');
        if (retires.length === 0) { reglerListe(ctx().sshConfig(), cote, famille, []); return ''; }
        return retirerDeLaListe(ctx(), cote, famille, retires);
      }))),

    spec('scp-server', ['ip', 'scp', 'server', 'enable'], 'Enable the SCP server',
      () => { ctx().sshConfig().scpServerEnabled = true; return ''; },
      () => { ctx().sshConfig().scpServerEnabled = false; return ''; }),
  );
  return specs;
}
