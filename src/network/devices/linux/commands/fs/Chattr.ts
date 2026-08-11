import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';

const ORDRE = 'suSDiadAcBZXEjItTeCFNPVm';

function chemin(ctx: LinuxCommandContext, cible: string): string {
  return ctx.executor.vfs.normalizePath(cible, ctx.executor.getCwd());
}

export const chattrCommand: LinuxCommand = {
  name: 'chattr',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/chattr',
  complete: makeArgCompleter({ flags: ['-R', '-V', '-f'] }),
  manSection: 1,
  usage: 'chattr [-RVf] [+-=mode] <file>...',
  help: 'Change file attributes on a Linux file system.',
  options: [
    { flag: '-R', description: 'Recursively change attributes of directories.' },
    { flag: '-V', description: 'Be verbose.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const mode = args.find((a) => /^[+\-=][a-zA-Z]+$/.test(a));
    const cibles = args.filter((a) => a !== mode && !/^-[RVf]+$/.test(a));
    if (!mode || cibles.length === 0) {
      return { output: 'Usage: chattr [-RVf] [+-=mode] <file>...', exitCode: 1 };
    }
    const signe = mode[0];
    const lettres = mode.slice(1);
    for (const l of lettres) {
      if (!ORDRE.includes(l)) {
        return { output: `chattr: Unrecognized argument: ${l}`, exitCode: 1 };
      }
    }
    const sorties: string[] = [];
    for (const cible of cibles) {
      const inode = ctx.executor.vfs.resolveInode(chemin(ctx, cible));
      if (!inode) {
        sorties.push(`chattr: No such file or directory while trying to stat ${cible}`);
        continue;
      }
      if (ctx.executor.userMgr.currentUid !== 0) {
        sorties.push(`chattr: Operation not permitted while setting flags on ${cible}`);
        continue;
      }
      if (signe === '=') inode.immutable = lettres.includes('i');
      else if (lettres.includes('i')) inode.immutable = signe === '+';
    }
    return { output: sorties.join('\n'), exitCode: sorties.length > 0 ? 1 : 0 };
  },
};

export const lsattrCommand: LinuxCommand = {
  name: 'lsattr',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/lsattr',
  complete: makeArgCompleter({ flags: ['-R', '-a', '-d'] }),
  manSection: 1,
  usage: 'lsattr [-RVadlpv] [files...]',
  help: 'List file attributes on a Linux second extended file system.',
  options: [
    { flag: '-a', description: 'List all files in directories, including dotfiles.' },
    { flag: '-d', description: 'List directories like other files, not their contents.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const vfs = ctx.executor.vfs;
    const tout = args.includes('-a');
    const commeFichier = args.includes('-d');
    const cibles = args.filter((a) => !a.startsWith('-'));
    const sorties: string[] = [];
    for (const cible of cibles.length > 0 ? cibles : ['.']) {
      const abs = chemin(ctx, cible);
      const inode = vfs.resolveInode(abs);
      if (!inode) {
        sorties.push(`lsattr: No such file or directory while trying to stat ${cible}`);
        continue;
      }
      if (inode.type === 'directory' && !commeFichier) {
        for (const nom of [...inode.children.keys()].sort()) {
          if (nom === '.' || nom === '..') continue;
          if (!tout && nom.startsWith('.')) continue;
          const rendu = cible === '.' ? `./${nom}` : `${abs}/${nom}`.replace(/\/+/g, '/');
          const enfant = vfs.resolveInode(`${abs}/${nom}`.replace(/\/+/g, '/'));
          sorties.push(`${drapeaux(enfant?.immutable === true)} ${rendu}`);
        }
        continue;
      }
      sorties.push(`${drapeaux(inode.immutable === true)} ${cible}`);
    }
    return { output: sorties.join('\n'), exitCode: 0 };
  },
};

function drapeaux(immuable: boolean): string {
  return ORDRE.split('').map((l) => {
    if (l === 'i') return immuable ? 'i' : '-';
    if (l === 'e') return 'e';
    return '-';
  }).join('');
}
