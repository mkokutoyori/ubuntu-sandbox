import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { linuxKrb5Host } from '../../kerberos/Krb5LinuxHost';
import { runKinit } from '../../kerberos/Kinit';
import { runKlist } from '../../kerberos/Klist';
import { runKdestroy } from '../../kerberos/Kdestroy';
import type { ToolOutput } from '../../kerberos/Krb5ToolOutput';

function shaped(result: ToolOutput) {
  return {
    output: result.stdout.replace(/\n$/, ''),
    stderr: result.stderr.replace(/\n$/, ''),
    interleaved: result.combined.replace(/\n$/, ''),
    exitCode: result.exitCode,
  };
}

export const kinitCommand: LinuxCommand = {
  name: 'kinit',
  package: 'krb5-user',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: 'kinit [options] [principal]',
  help: 'kinit - obtain and cache Kerberos ticket-granting ticket',
  complete: makeArgCompleter({ flags: ['-V', '-l', '-s', '-r', '-f', '-F', '-p', '-P', '-n', '-a', '-A', '-C', '-E', '-v', '-R', '-k', '-i', '-t', '-c', '-S', '-I', '-T', '-X'] }),
  options: [
    { flag: '-V', description: 'verbose' },
    { flag: '-l', description: 'lifetime', takesArg: true, argName: 'lifetime' },
    { flag: '-r', description: 'renewable lifetime', takesArg: true, argName: 'renewable_life' },
    { flag: '-f', description: 'forwardable' },
    { flag: '-F', description: 'not forwardable' },
    { flag: '-p', description: 'proxiable' },
    { flag: '-P', description: 'not proxiable' },
    { flag: '-c', description: 'Kerberos 5 cache name', takesArg: true, argName: 'cachename' },
    { flag: '-S', description: 'service', takesArg: true, argName: 'service_name' },
  ],
  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return shaped(await runKinit(linuxKrb5Host(ctx), args, stdin ?? null)).interleaved;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return shaped(await runKinit(linuxKrb5Host(ctx), args, stdin ?? null));
  },
};

export const klistCommand: LinuxCommand = {
  name: 'klist',
  package: 'krb5-user',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'klist [options] [name]',
  help: 'klist - list cached Kerberos tickets',
  complete: makeArgCompleter({ flags: ['-e', '-V', '-c', '-l', '-A', '-d', '-f', '-s', '-a', '-n', '-k', '-i', '-t', '-K', '-C'] }),
  options: [
    { flag: '-e', description: 'shows the encryption type' },
    { flag: '-V', description: 'shows the Kerberos version and exits' },
    { flag: '-f', description: 'shows credentials flags' },
    { flag: '-s', description: 'sets exit status based on valid tgt existence' },
    { flag: '-a', description: 'displays the address list' },
    { flag: '-l', description: 'lists credential caches in collection' },
    { flag: '-A', description: 'shows content of all credential caches' },
  ],
  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return shaped(await runKlist(linuxKrb5Host(ctx), args)).interleaved;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return shaped(await runKlist(linuxKrb5Host(ctx), args));
  },
};

export const kdestroyCommand: LinuxCommand = {
  name: 'kdestroy',
  package: 'krb5-user',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'kdestroy [-A] [-q] [-c cache_name] [-p princ_name]',
  help: 'kdestroy - destroy Kerberos tickets',
  complete: makeArgCompleter({ flags: ['-A', '-q', '-c', '-p'] }),
  options: [
    { flag: '-A', description: 'destroy all credential caches in collection' },
    { flag: '-q', description: 'quiet mode' },
    { flag: '-c', description: 'specify name of credentials cache', takesArg: true, argName: 'cache_name' },
    { flag: '-p', description: 'specify principal name within collection', takesArg: true, argName: 'princ_name' },
  ],
  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return shaped(await runKdestroy(linuxKrb5Host(ctx), args)).interleaved;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return shaped(await runKdestroy(linuxKrb5Host(ctx), args));
  },
};
