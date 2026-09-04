import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { RSA_MODULUS_DEFAUT, RSA_MODULUS_MAX, RSA_MODULUS_MIN } from './CiscoSecurityCommands';

export interface CryptoRsaKeyRecord {
  label: string;
  modulus: number;
  general: boolean;
  generatedAtMs: number;
}

export interface CryptoKeyHost {
  domainName(): string;
  hostname(): string;
  keys(): CryptoRsaKeyRecord[];
  setKeys(keys: CryptoRsaKeyRecord[]): void;
  refreshSshAvailability(): void;
}

const MODES = ['config'] as const;

/**
 * Les options de `crypto key generate rsa`, en ORDRE LIBRE.
 *
 * C'est la premiere famille a passer par le sac d'options du socle, et
 * c'est elle qui l'a rendu necessaire : ses quatre mots-cles se tapent
 * dans n'importe quel ordre, ce qu'un chemin — qui est une SEQUENCE — ne
 * sait pas dire. `signature` et `encryption` sont les deux moities que
 * `usage-keys` produit ; IOS les accepte a cette place, et ce
 * simulateur les acceptait deja.
 */
const GENERATE_OPTIONS: readonly OptionSpec[] = [
  { keyword: 'general-keys', description: 'Generate a general purpose RSA key pair for signing and encryption' },
  { keyword: 'usage-keys', description: 'Generate separate RSA key pairs for signing and encryption' },
  { keyword: 'signature', description: 'Generate a general purpose RSA key pair for signing' },
  { keyword: 'encryption', description: 'Generate a general purpose RSA key pair for encryption' },
  { keyword: 'exportable', description: 'Allow the key to be exported' },
  {
    keyword: 'label',
    description: 'Provide a label',
    argument: { name: 'label', type: 'WORD', description: 'RSA key label' },
  },
  {
    keyword: 'modulus',
    description: 'Provide number of modulus bits on the command line',
    argument: {
      name: 'modulus', type: 'INT', range: [RSA_MODULUS_MIN, RSA_MODULUS_MAX],
      description: 'Size of the key modulus',
    },
  },
];

export function cryptoKeySpecs(ctx: () => CryptoKeyHost): CommandSpec[] {
  return [
    {
      id: 'crypto-key-generate-rsa',
      path: ['crypto', 'key', 'generate', 'rsa'],
      description: 'Generate RSA key',
      modes: MODES, minPrivilege: 15,
      options: GENERATE_OPTIONS,
      run: (_session, args) => {
        const host = ctx();
        const domain = host.domainName();
        // Sans `label`, IOS nomme la paire d'apres l'identite pleinement
        // qualifiee du routeur — c'est pour cela qu'il exige un nom de
        // domaine avant de la generer.
        if (!domain) return '% Please define a domain-name first.';

        const modulus = args.modulus === undefined
          ? RSA_MODULUS_DEFAUT : Number(args.modulus);
        const label = args.label ?? `${host.hostname()}.${domain}`;
        // `crypto key generate rsa` produit une paire a usage GENERAL ;
        // ce sont `usage-keys` qui en produisent deux, dont une de
        // signature.
        const general = args['usage-keys'] === undefined;

        host.keys().push({ label, modulus, general, generatedAtMs: Date.now() });
        // Generer les cles est ce qui monte le serveur SSH sur IOS, donc
        // l'ecouteur doit suivre : la configuration et le service ne
        // peuvent pas se contredire.
        host.refreshSshAvailability();
        const elapsedSec = Math.max(1, Math.round(modulus / 1024));
        return [
          `The name for the keys will be: ${label}`,
          `% The key modulus size is ${modulus} bits`,
          `% Generating ${modulus} bit RSA keys, keys will be non-exportable...`,
          `[OK] (elapsed time was ${elapsedSec} seconds)`,
        ].join('\n');
      },
    },
    {
      id: 'crypto-key-zeroize-rsa',
      path: ['crypto', 'key', 'zeroize', 'rsa', {
        name: 'label', type: 'WORD', optional: true,
        description: 'Key pair label',
      }],
      description: 'Delete RSA host keys',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        const host = ctx();
        // Le nom de la paire etait accepte et JETE : `crypto key zeroize
        // rsa MACLE` effacait TOUTES les cles, y compris celles que
        // l'operateur venait de nommer pour les garder.
        const vises = args.label === undefined
          ? host.keys()
          : host.keys().filter(key => key.label === args.label);
        if (vises.length === 0) {
          return '% No Signature RSA Keys found in configuration.';
        }
        const fqdn = args.label ?? `${host.hostname()}.${host.domainName()}`;
        host.setKeys(host.keys().filter(key => !vises.includes(key)));
        // Effacer les cles coupe reellement SSH — c'est le §F7.2 du
        // routeur, et la facon classique de s'enfermer dehors sur une
        // machine qu'on administre par SSH.
        host.refreshSshAvailability();
        return `% Keys to be removed are named ${fqdn}.`;
      },
    },
  ];
}
