import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

/**
 * L'exécution de adduser/addgroup est migrée vers command-kernel
 * (`linux/command-kernel/commands/Adduser.ts`) et le hook kernel est
 * consulté avant ce registre sur tous les chemins de dispatch : ces
 * entrées ne servent plus que `man`/`--help`/la complétion. Les prompts
 * interactifs (mot de passe, GECOS) restent pilotés par
 * `LinuxFlowBuilder`, qui exécute la création via la commande migrée.
 */

const ADDUSER_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '--uid', dest: 'uid', takesArg: true, argName: 'id', description: 'Force the UID of the new account' },
  { flag: '--gid', dest: 'gid', takesArg: true, argName: 'id', description: 'Force the primary GID of the new account' },
  { flag: '--ingroup', dest: 'ingroup', takesArg: true, argName: 'group', description: 'Add the new user to an existing group instead of a new user-private group' },
  { flag: '--home', dest: 'home', takesArg: true, argName: 'dir', description: 'Set the home directory' },
  { flag: '--shell', dest: 'shell', takesArg: true, argName: 'shell', description: 'Set the login shell' },
  { flag: '--gecos', dest: 'gecos', takesArg: true, argName: 'text', description: 'Set the GECOS field, suppressing the interactive finger-info prompts' },
  { flag: '--system', dest: 'system', description: 'Create a system account' },
  { flag: '--group', dest: 'groupMode', description: 'Create a group instead of a user (same as addgroup)' },
  { flag: '--disabled-password', dest: 'disabledPassword', description: 'Create the account with no usable password' },
  { flag: '--disabled-login', aliases: ['--disabled-password'], dest: 'disabledPassword', description: 'Create the account with the login disabled' },
  { flag: '--no-create-home', dest: 'noCreateHome', description: 'Do not create the home directory' },
];

function migratedToKernel(name: string): never {
  throw new Error(`${name}: exécution migrée vers command-kernel — cette entrée ne sert que man/help`);
}

export const adduserCommand: LinuxCommand = {
  name: 'adduser',
  needsNetworkContext: false,
  usage: 'adduser [options] LOGIN [GROUP]',
  options: ADDUSER_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: () => migratedToKernel('adduser'),
  runWithStatus: () => migratedToKernel('adduser'),
};

export const addgroupCommand: LinuxCommand = {
  name: 'addgroup',
  needsNetworkContext: false,
  usage: 'addgroup [options] GROUP',
  options: ADDUSER_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: () => migratedToKernel('addgroup'),
  runWithStatus: () => migratedToKernel('addgroup'),
};
