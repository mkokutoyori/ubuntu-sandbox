import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';

/**
 * L'exécution de useradd est migrée vers command-kernel
 * (`linux/command-kernel/commands/Useradd.ts`) et le hook kernel est
 * consulté avant ce registre sur tous les chemins de dispatch : cette
 * entrée ne sert plus que `man`/`--help`/la complétion.
 */

const USERADD_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-u', aliases: ['--uid'], dest: 'uid', takesArg: true, argName: 'uid', description: 'Set the numeric UID of the new account' },
  { flag: '-g', aliases: ['--gid'], dest: 'primaryGroup', takesArg: true, argName: 'group', description: 'Set the primary group by name or GID' },
  { flag: '-G', aliases: ['--groups'], dest: 'supplementaryGroups', takesArg: true, argName: 'group1,group2,...', description: 'Set supplementary groups' },
  { flag: '-d', aliases: ['--home-dir', '--home'], dest: 'home', takesArg: true, argName: 'home_dir', description: 'Set the home directory' },
  { flag: '-b', aliases: ['--base-dir'], dest: 'baseDir', takesArg: true, argName: 'base_dir', description: 'Base directory for the new home (default /home)' },
  { flag: '-s', aliases: ['--shell'], dest: 'shell', takesArg: true, argName: 'shell', description: 'Set the login shell' },
  { flag: '-c', aliases: ['--comment'], dest: 'comment', takesArg: true, argName: 'comment', description: 'Set the GECOS field' },
  { flag: '-p', aliases: ['--password'], dest: 'passwordHash', takesArg: true, argName: 'hash', description: 'Set an already-hashed password' },
  { flag: '-e', aliases: ['--expiredate'], dest: 'expireDate', takesArg: true, argName: 'date', description: 'Set the account expiration date' },
  { flag: '-f', aliases: ['--inactive'], dest: 'inactiveDays', takesArg: true, argName: 'days', description: 'Set the password inactivity period' },
  { flag: '-k', aliases: ['--skel'], dest: 'skeletonDir', takesArg: true, argName: 'skel_dir', description: 'Alternate skeleton directory' },
  { flag: '-m', aliases: ['--create-home'], dest: 'createHome', description: 'Create the home directory' },
  { flag: '-M', aliases: ['--no-create-home'], dest: 'noCreateHome', description: 'Do not create the home directory' },
  { flag: '-r', aliases: ['--system'], dest: 'systemAccount', description: 'Create a system account' },
  { flag: '-o', aliases: ['--non-unique'], dest: 'nonUnique', description: 'Allow a non-unique UID' },
  { flag: '-N', aliases: ['--no-user-group'], dest: 'noUserGroup', description: 'Do not create a group with the same name as the user' },
  { flag: '-U', aliases: ['--user-group'], dest: 'userGroup', description: 'Create a group with the same name as the user' },
];

function migratedToKernel(): never {
  throw new Error('useradd: exécution migrée vers command-kernel — cette entrée ne sert que man/help');
}

export const useraddCommand: LinuxCommand = {
  name: 'useradd',
  needsNetworkContext: false,
  usage: 'useradd [options] LOGIN',
  options: USERADD_OPTIONS,
  privilege: { satisfiedBy: Satisfy.root },
  run: () => migratedToKernel(),
  runWithStatus: () => migratedToKernel(),
};
