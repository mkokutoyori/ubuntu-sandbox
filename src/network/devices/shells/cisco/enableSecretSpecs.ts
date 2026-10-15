import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { EnableSecretAlgorithm } from '../../../equipment/Equipment';
import { TYPE4_DEPRECATION_WARNING, invalidEncryptedSecretMessage, isWellFormedSecret } from './ciscoPasswordVerify';

const MODES = ['config'] as const;
const LEVEL_RANGE: readonly [number, number] = [1, 15];
const INCOMPLETE = '% Incomplete command.';

export interface EnableHost {
  setSecret(level: number, secret: string, algorithm: EnableSecretAlgorithm): void;
  setPassword(level: number, password: string, algorithm: 'plain' | 'type-7'): void;
  clearSecret(level: number): void;
  clearPassword(level: number): void;
  minPasswordLength(): number | undefined;
  passwordEncryptionEnabled(): boolean;
  encryptType7(password: string): string;
}

const SECRET_ALGORITHMS: Readonly<Record<string, EnableSecretAlgorithm>> = {
  '0': 'plain', '4': 'type-4', '5': 'md5', '7': 'type-7', '8': 'sha256', '9': 'scrypt',
};

const SECRET_FORMS: ArgumentSpec = {
  name: 'secret', type: 'REST', literal: 'LINE', description: 'The UNENCRYPTED (cleartext) \'enable\' secret',
  alternatives: [
    { keyword: '0', description: 'Specifies an UNENCRYPTED password will follow', thenWord: 'The UNENCRYPTED (cleartext) \'enable\' secret' },
    { keyword: '5', description: 'Specifies an ENCRYPTED secret will follow', thenWord: 'The HASHED \'enable\' secret' },
    { keyword: '8', description: 'Specifies a PBKDF2 HASHED secret will follow', thenWord: 'The HASHED \'enable\' secret' },
    { keyword: '9', description: 'Specifies a SCRYPT HASHED secret will follow', thenWord: 'The HASHED \'enable\' secret' },
    { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) \'enable\' secret' },
  ],
};

const PASSWORD_FORMS: ArgumentSpec = {
  name: 'password', type: 'REST', literal: 'LINE', description: 'The UNENCRYPTED (cleartext) \'enable\' password',
  alternatives: [
    { keyword: '0', description: 'Specifies an UNENCRYPTED password will follow', thenWord: 'The UNENCRYPTED (cleartext) \'enable\' password' },
    { keyword: '7', description: 'Specifies a HIDDEN password will follow', thenWord: 'The HIDDEN \'enable\' password' },
    { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) \'enable\' password' },
  ],
};

const LEVEL: ArgumentSpec = { name: 'level', type: 'INT', range: LEVEL_RANGE, description: 'Level number' };

const ALGORITHM: ArgumentSpec = {
  name: 'algorithm', type: 'ENUM', description: 'Algorithm to hash the secret with',
  values: [
    { keyword: 'md5', description: 'Select MD5 as the hashing algorithm' },
    { keyword: 'scrypt', description: 'Select scrypt as the hashing algorithm' },
    { keyword: 'sha256', description: 'Select PBKDF2 with SHA256 as the hashing algorithm' },
  ],
};

const CLEARTEXT_SECRET: ArgumentSpec = {
  name: 'secret', type: 'REST', literal: 'LINE', description: 'The UNENCRYPTED (cleartext) \'enable\' secret',
};

const tooShort = (minimum: number): string =>
  `Password too short - must be at least ${minimum} characters. Password configuration failed`;

function applySecret(host: EnableHost, level: number, rest: string): string {
  const words = rest.split(/\s+/).filter(Boolean);
  const named = SECRET_ALGORITHMS[words[0] ?? ''];
  if (named !== undefined && words.length === 1) return INCOMPLETE;
  let algorithm: EnableSecretAlgorithm = 'md5';
  let secret: string;
  let clear: string | undefined;
  if (named !== undefined) {
    algorithm = named;
    secret = words.slice(1).join(' ');
    if (!isWellFormedSecret(words[0], secret)) return invalidEncryptedSecretMessage(words[0]);
    if (named === 'plain') clear = secret;
  } else {
    secret = words.join(' ');
    clear = secret;
  }
  const minimum = host.minPasswordLength();
  if (clear !== undefined && minimum && clear.length < minimum) return tooShort(minimum);
  host.setSecret(level, secret, algorithm);
  return algorithm === 'type-4' ? TYPE4_DEPRECATION_WARNING : '';
}

function applyPassword(host: EnableHost, level: number, rest: string): string {
  const words = rest.split(/\s+/).filter(Boolean);
  let algorithm: 'plain' | 'type-7' = 'plain';
  let password: string;
  let clear: string | undefined;
  if (words[0] === '0') {
    password = words.slice(1).join(' ');
    clear = password;
  } else if (words[0] === '7') {
    algorithm = 'type-7';
    password = words.slice(1).join(' ');
  } else {
    password = words.join(' ');
    clear = password;
  }
  if (password === '') return INCOMPLETE;
  const minimum = host.minPasswordLength();
  if (clear !== undefined && minimum && clear.length < minimum) return tooShort(minimum);
  if (algorithm === 'plain' && host.passwordEncryptionEnabled()) host.setPassword(level, host.encryptType7(password), 'type-7');
  else host.setPassword(level, password, algorithm);
  return '';
}

function applyExplicitAlgorithm(host: EnableHost, level: number, algorithm: string, secret: string): string {
  const minimum = host.minPasswordLength();
  if (minimum && secret.length < minimum) return tooShort(minimum);
  host.setSecret(level, secret, algorithm as EnableSecretAlgorithm);
  return '';
}

export function enableSecretSpecs(ctx: () => EnableHost): CommandSpec[] {
  return [
    {
      id: 'enable-secret',
      path: ['enable', 'secret', SECRET_FORMS],
      description: 'Assign the privileged level secret',
      undoDescription: 'Remove the privileged level secret',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => applySecret(ctx(), 15, args.secret),
      undo: () => { ctx().clearSecret(15); return ''; },
    },
    {
      id: 'enable-secret-level',
      path: ['enable', 'secret', 'level', LEVEL, SECRET_FORMS],
      description: 'Set exec level password',
      undoDescription: 'Remove the secret of an exec level',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => applySecret(ctx(), Number(args.level), args.secret),
      undo: (_s, args) => { ctx().clearSecret(args.level === undefined ? 15 : Number(args.level)); return ''; },
    },
    {
      id: 'enable-password',
      path: ['enable', 'password', PASSWORD_FORMS],
      description: 'Assign the privileged level password',
      undoDescription: 'Remove the privileged level password',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => applyPassword(ctx(), 15, args.password),
      undo: () => { ctx().clearPassword(15); return ''; },
    },
    {
      id: 'enable-password-level',
      path: ['enable', 'password', 'level', LEVEL, PASSWORD_FORMS],
      description: 'Set exec level password',
      undoDescription: 'Remove the password of an exec level',
      modes: MODES, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => applyPassword(ctx(), Number(args.level), args.password),
      undo: (_s, args) => { ctx().clearPassword(args.level === undefined ? 15 : Number(args.level)); return ''; },
    },
    {
      id: 'enable-algorithm-type',
      path: ['enable', 'algorithm-type', ALGORITHM, 'secret', CLEARTEXT_SECRET],
      description: 'Set enable secret with an explicit hash algorithm',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => applyExplicitAlgorithm(ctx(), 15, args.algorithm, args.secret),
    },
    {
      id: 'enable-algorithm-type-level',
      path: ['enable', 'algorithm-type', ALGORITHM, 'secret', 'level', LEVEL, CLEARTEXT_SECRET],
      description: 'Set exec level secret with an explicit hash algorithm',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => applyExplicitAlgorithm(ctx(), Number(args.level), args.algorithm, args.secret),
    },
  ];
}
