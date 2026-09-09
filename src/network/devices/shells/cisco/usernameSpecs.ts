import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';

const MODES = ['config'] as const;

export const PRIVILEGE_RANGE: readonly [number, number] = [0, 15];
export const ACCESS_CLASS_RANGE: readonly [number, number] = [1, 199];
export const USER_MAXLINKS_RANGE: readonly [number, number] = [0, 255];

export type UsernameSecretAlgo =
  'plain' | 'plain-password' | 'md5' | 'sha256' | 'scrypt' | 'type-7';

export interface UsernameSettings {
  privilege?: number;
  secret?: string;
  secretAlgo?: UsernameSecretAlgo;
  nopassword?: boolean;
  description?: string;
  view?: string;
  autocommand?: string;
  nohangup?: boolean;
  oneTime?: boolean;
  accessClass?: number;
  maxLinks?: number;
}

export interface UsernameHost {
  viewExists(name: string): boolean;
  minPasswordLength(): number | undefined;
  upsert(name: string, settings: UsernameSettings): void;
  remove(name: string): void;
}

const ligne = (nom: string, description: string): ArgumentSpec =>
  ({ name: nom, type: 'REST', literal: 'LINE', description });

const CHIFFRES_SECRET: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: '0', description: 'Specifies an UNENCRYPTED secret will follow' },
  { keyword: '5', description: 'Specifies a MD5 HASHED secret will follow' },
  { keyword: '8', description: 'Specifies a PBKDF2 HASHED secret will follow' },
  { keyword: '9', description: 'Specifies a SCRYPT HASHED secret will follow' },
  { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) user secret' },
];

const CHIFFRES_PASSWORD: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: '0', description: 'Specifies an UNENCRYPTED password will follow' },
  { keyword: '7', description: 'Specifies a HIDDEN password will follow' },
  { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) user password' },
];

export const USERNAME_OPTIONS: readonly OptionSpec[] = [
  {
    keyword: 'access-class', description: 'Restrict access by access-class',
    argument: {
      name: 'access-class', type: 'INT', range: ACCESS_CLASS_RANGE,
      description: 'Access-list number',
    },
  },
  {
    keyword: 'algorithm-type', description: 'Algorithm used to hash the password',
    argument: {
      name: 'algorithm-type', type: 'ENUM', description: 'Hashing algorithm',
      values: [
        { keyword: 'md5', description: 'Select MD5 as the hashing algorithm' },
        { keyword: 'scrypt', description: 'Select scrypt as the hashing algorithm' },
        { keyword: 'sha256', description: 'Select PBKDF2 with SHA-256 as the hashing algorithm' },
      ],
    },
  },
  {
    keyword: 'autocommand',
    description: 'Automatically issue a command after the user logs in',
    argument: ligne('autocommand', 'The command to issue'),
  },
  {
    keyword: 'description', description: 'Description of the user',
    argument: ligne('description', 'Text describing the user'),
  },
  { keyword: 'nohangup', description: 'Do not disconnect after an automatic command' },
  { keyword: 'nopassword', description: 'No password is required for this user' },
  { keyword: 'one-time', description: 'Specify a one-time user name' },
  {
    keyword: 'password', description: 'Specify the password for the user',
    argument: {
      name: 'password', type: 'REST', literal: 'LINE',
      description: 'The password itself', alternatives: CHIFFRES_PASSWORD,
    },
  },
  {
    keyword: 'privilege', description: 'Set the privilege level for the user',
    argument: {
      name: 'privilege', type: 'INT', range: PRIVILEGE_RANGE,
      description: 'User privilege level',
    },
  },
  {
    keyword: 'secret', description: 'Specify the secret for the user',
    argument: {
      name: 'secret', type: 'REST', literal: 'LINE',
      description: 'The secret itself', alternatives: CHIFFRES_SECRET,
    },
  },
  {
    keyword: 'user-maxlinks', description: 'Limit the user to a number of connections',
    argument: {
      name: 'user-maxlinks', type: 'INT', range: USER_MAXLINKS_RANGE,
      description: 'Maximum number of connections',
    },
  },
  {
    keyword: 'view', description: 'Set the view attached to the user',
    argument: { name: 'view', type: 'WORD', description: 'Name of the parser view' },
  },
];

const ALGOS_CONDENSE: Readonly<Record<string, UsernameSecretAlgo>> = {
  0: 'plain', 4: 'sha256', 5: 'md5', 8: 'sha256', 9: 'scrypt',
};

interface SecretLu {
  readonly valeur: string;
  readonly algo: UsernameSecretAlgo;
  readonly clair?: string;
}

function lireSecret(brut: string, demande?: UsernameSecretAlgo): SecretLu {
  const coupe = brut.indexOf(' ');
  const tete = coupe === -1 ? brut : brut.slice(0, coupe);
  const algo = ALGOS_CONDENSE[tete];
  if (algo !== undefined && coupe !== -1) {
    const valeur = brut.slice(coupe + 1);
    return algo === 'plain' ? { valeur, algo, clair: valeur } : { valeur, algo };
  }
  return { valeur: brut, algo: demande ?? 'md5', clair: brut };
}

function lirePassword(brut: string): SecretLu {
  const coupe = brut.indexOf(' ');
  const tete = coupe === -1 ? brut : brut.slice(0, coupe);
  if (tete === '7' && coupe !== -1) {
    return { valeur: brut.slice(coupe + 1), algo: 'type-7' };
  }
  const valeur = tete === '0' && coupe !== -1 ? brut.slice(coupe + 1) : brut;
  return { valeur, algo: 'plain-password', clair: valeur };
}

const AVERTISSEMENT_TYPE_0 =
  'WARNING: Command has been added to the configuration using a type 0\n'
  + 'password. However, type 0 passwords will soon be deprecated. Migrate\n'
  + 'to a supported password type';

export function usernameSpecs(ctx: () => UsernameHost): CommandSpec[] {
  return [{
    id: 'username',
    path: ['username', { name: 'nom', type: 'WORD', description: 'User name' }],
    description: 'Establish User Name Authentication',
    undoDescription: 'Remove a local user',
    modes: MODES, minPrivilege: 15,
    options: USERNAME_OPTIONS,
    run: (_session, args) => {
      const hote = ctx();
      const demande = args['algorithm-type'] as UsernameSecretAlgo | undefined;
      const lu = args.secret !== undefined ? lireSecret(args.secret, demande)
        : args.password !== undefined ? lirePassword(args.password)
          : undefined;

      if (args.view !== undefined && !hote.viewExists(args.view)) {
        return `%Error: View ${args.view} is not present in the system`;
      }
      const minimum = hote.minPasswordLength();
      if (args.nopassword === undefined && lu?.clair !== undefined
        && minimum && lu.clair.length < minimum) {
        return `Password too short - must be at least ${minimum} characters.`
          + ' Password configuration failed';
      }

      hote.upsert(args.nom, {
        privilege: args.privilege === undefined ? undefined : Number(args.privilege),
        secret: lu?.valeur,
        secretAlgo: lu?.algo ?? 'plain',
        nopassword: args.nopassword !== undefined,
        description: args.description,
        view: args.view,
        autocommand: args.autocommand,
        nohangup: args.nohangup !== undefined,
        oneTime: args['one-time'] !== undefined,
        accessClass: args['access-class'] === undefined
          ? undefined : Number(args['access-class']),
        maxLinks: args['user-maxlinks'] === undefined
          ? undefined : Number(args['user-maxlinks']),
      });
      return lu?.algo === 'plain-password' && lu.clair !== undefined
        ? AVERTISSEMENT_TYPE_0 : '';
    },
    undo: (_session, args) => { ctx().remove(args.nom); return ''; },
  }];
}
