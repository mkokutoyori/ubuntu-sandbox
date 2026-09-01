/**
 * `lid` et `members` — les deux sens de l'appartenance à un groupe.
 *
 * `LinuxUserManager` porte déjà toute la donnée (`getUserGroups`,
 * `getAllGroups`, `LinuxGroup.members`) et `groups`/`id` la lisent depuis
 * toujours. Ce qui manquait, c'est le **sens inverse** : « qui est dans ce
 * groupe ? ». `groups alice` répond dans un sens, rien ne répondait dans
 * l'autre, et c'est pourtant la question qu'on pose en auditant un `sudo`
 * ou un partage.
 *
 *   - `lid <user>` liste les groupes de l'utilisateur ;
 *   - `lid -g <group>` liste les utilisateurs du groupe ;
 *   - `members <group>` fait la même chose que `lid -g`, mais sur une
 *     seule ligne séparée par des espaces — la forme qui se met dans une
 *     boucle `for`.
 *
 * Une appartenance a deux origines et les deux comptent : le groupe
 * **primaire** (le gid de l'entrée `/etc/passwd`) et les groupes
 * **secondaires** (la liste de membres de `/etc/group`). N'en compter
 * qu'une donnerait un audit faux dans le sens qui compte : sur Debian,
 * l'utilisateur `alice` a `alice` comme groupe primaire, et ce groupe ne
 * la nomme pas dans `/etc/group`. Les deux sources sont donc unies ici.
 *
 * `lid` demande les privilèges root sur un vrai système — il lit la base
 * shadow — et le refus est modélisé plutôt que contourné. `members` non :
 * il ne lit que `/etc/group`, lisible par tous.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/** Groupes de `user`, primaire compris, triés par gid comme `lid`. */
function groupsOf(ctx: LinuxCommandContext, user: string): Array<{ name: string; gid: number }> {
  const mgr = ctx.executor.userMgr;
  const account = mgr.getUser(user);
  if (!account) return [];
  const seen = new Map<string, number>();
  const primary = mgr.getGroupByGid(account.gid);
  if (primary) seen.set(primary.name, primary.gid);
  for (const g of mgr.getUserGroups(user)) seen.set(g.name, g.gid);
  return [...seen].map(([name, gid]) => ({ name, gid })).sort((a, b) => a.gid - b.gid);
}

/** Membres de `group`, ceux qui l'ont pour groupe primaire compris. */
export function membersOf(ctx: LinuxCommandContext, group: string): string[] {
  const mgr = ctx.executor.userMgr;
  const g = mgr.getGroup(group);
  if (!g) return [];
  const names = new Set<string>(g.members ?? []);
  for (const u of mgr.getAllUsers()) if (u.gid === g.gid) names.add(u.username);
  return [...names].sort((a, b) => a.localeCompare(b));
}

export const lidCommand: LinuxCommand = {
  name: 'lid',
  package: 'libuser',
  aliases: ['libuser-lid'],
  needsNetworkContext: true,
  usage: 'lid [-g] name',
  manSection: 1,
  binaryPath: '/usr/sbin/lid',
  help: 'List user\'s groups or group\'s users.',
  options: [
    { flag: '-g', aliases: ['--group'], dest: 'group', description: 'List the users in the named group' },
  ],
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    if (ctx.executor.userMgr.currentUid !== 0) {
      return { output: 'lid: Error looking up the user or group: Permission denied', exitCode: 1 };
    }
    const byGroup = args.includes('-g') || args.includes('--group');
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) {
      return { output: 'lid: No user name specified.', exitCode: 1 };
    }

    if (byGroup) {
      const g = ctx.executor.userMgr.getGroup(name);
      if (!g) return { output: `lid: Group ${name} does not exist`, exitCode: 1 };
      const users = membersOf(ctx, name);
      if (users.length === 0) return { output: '', exitCode: 0 };
      const uid = (u: string) => ctx.executor.userMgr.getUser(u)?.uid ?? 0;
      return { output: users.map((u) => ` ${u}(${uid(u)})`).join('\n'), exitCode: 0 };
    }

    if (!ctx.executor.userMgr.getUser(name)) {
      return { output: `lid: User ${name} does not exist`, exitCode: 1 };
    }
    const groups = groupsOf(ctx, name);
    return { output: groups.map((g) => ` ${g.name}(${g.gid})`).join('\n'), exitCode: 0 };
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },
};

export const membersCommand: LinuxCommand = {
  name: 'members',
  package: 'members',
  needsNetworkContext: true,
  usage: 'members [-p|-s|-a] group',
  manSection: 1,
  help: 'List members of a group.',
  options: [
    { flag: '-p', dest: 'primary', description: 'Show only primary members' },
    { flag: '-s', dest: 'secondary', description: 'Show only secondary members' },
    { flag: '-a', dest: 'all', description: 'Show both primary and secondary members (default)' },
  ],
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const mgr = ctx.executor.userMgr;
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) return { output: 'Usage: members [-p|-s|-a] groupname', exitCode: 1 };
    const g = mgr.getGroup(name);
    if (!g) return { output: `members: Group ${name} does not exist.`, exitCode: 1 };

    const primaryOnly = args.includes('-p');
    const secondaryOnly = args.includes('-s');
    let names: string[];
    if (primaryOnly) {
      names = mgr.getAllUsers().filter((u) => u.gid === g.gid).map((u) => u.username).sort();
    } else if (secondaryOnly) {
      names = [...(g.members ?? [])].sort();
    } else {
      names = membersOf(ctx, name);
    }
    return { output: names.join(' '), exitCode: 0 };
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },
  complete(ctx: LinuxCommandContext): string[] {
    return ctx.executor.userMgr.getAllGroups().map((g) => g.name);
  },
};
