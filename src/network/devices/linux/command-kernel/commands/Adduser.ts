import { CommandContext, CommandDescriptor, ExitCode, EXIT_OK } from '@/command-kernel/command/types';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { PrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { AuthorizationResult, PrivilegeLevel, User } from '@/command-kernel/session/types';

class RootWithVendorDenialPolicy implements PrivilegePolicy {
  readonly minLevel = PrivilegeLevel.ROOT;

  constructor(private readonly commandName: string) {}

  authorize(user: User): AuthorizationResult {
    if (user.isRoot()) return { granted: true };
    return {
      granted: false,
      reason: 'root requis',
      denialMessage: `${this.commandName}: Permission denied`,
    };
  }
}

type AdduserMode = 'create-user' | 'add-to-group' | 'create-group';

interface ParsedAdduser {
  mode: AdduserMode;
  name: string;
  group: string;
  system: boolean;
  uid?: number;
  gid?: number;
  ingroup?: string;
  home?: string;
  shell?: string;
  gecos?: string;
  noCreateHome: boolean;
}

const VALUE_OPTIONS = new Set(['--uid', '--gid', '--ingroup', '--home', '--shell', '--gecos']);
const BOOLEAN_OPTIONS = new Set([
  '--system', '--group', '--disabled-password', '--disabled-login', '--no-create-home',
]);

export class AdduserCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'adduser',
    summary: 'Add a user or group to the system (Debian front-end).',
    usage: 'adduser [options] LOGIN [GROUP]',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et login/groupe (grammaire Debian, analysée par la commande)' }],
    options: [],
    privileges: new RootWithVendorDenialPolicy('adduser'),
    category: 'iam',
    lenientOptions: true,
  };

  protected get groupAlias(): boolean { return false; }
  protected get commandName(): string { return 'adduser'; }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const out = (text: string) => ctx.io.stdout.write(`${text}\n`);
    const parsed = this.parse([...ctx.rawArgv]);

    if (parsed.mode === 'create-group') {
      return this.createGroup(ctx, parsed, out);
    }
    if (!parsed.name) {
      await out('adduser: missing user name');
      return 1;
    }
    if (parsed.mode === 'add-to-group') {
      return this.addToGroup(ctx, parsed, out);
    }
    return this.createUser(ctx, parsed, out);
  }

  private async createUser(
    ctx: CommandContext,
    req: ParsedAdduser,
    out: (t: string) => Promise<void>,
  ): Promise<ExitCode> {
    const users = ctx.machine.users;
    if (await users.findByName(req.name)) {
      await out(`adduser: The user \`${req.name}' already exists.`);
      return 1;
    }
    if (req.ingroup && !(await ctx.machine.groups.findByName(req.ingroup))) {
      await out(`adduser: The group \`${req.ingroup}' does not exist.`);
      return 1;
    }
    if (!users.posixUseradd) {
      await out('adduser: cannot lock /etc/passwd; try again later.');
      return 1;
    }

    const createHome = !req.noCreateHome;
    const shell = req.shell ?? (req.system ? '/usr/sbin/nologin' : '/bin/bash');
    const result = users.posixUseradd(req.name, {
      createHome,
      noCreateHome: req.noCreateHome,
      shell,
      home: req.home,
      primaryGroup: req.ingroup,
      comment: req.gecos,
      uid: req.uid,
      system: req.system,
    });
    if (result) {
      await out(`adduser: ${result}`);
      return 1;
    }

    const info = users.posixAccountInfo?.(req.name);
    if (createHome) users.createHomeSkeleton?.(req.name);

    const uid = info?.uid ?? 0;
    const gid = info?.gid ?? 0;
    const home = info?.home ?? `/home/${req.name}`;
    const groupName = users.primaryGroupName?.(req.name) ?? req.ingroup ?? req.name;
    await out(req.system
      ? `Adding system user \`${req.name}' (${uid}) ...`
      : `Adding user \`${req.name}' ...`);
    if (!req.ingroup) {
      await out(`Adding new group \`${groupName}' (${gid}) ...`);
    }
    await out(`Adding new user \`${req.name}' (${uid}) with group \`${groupName}' ...`);
    if (createHome) {
      await out(`Creating home directory \`${home}' ...`);
      await out(`Copying files from \`/etc/skel' ...`);
    } else {
      await out(`Not creating home directory \`${home}'.`);
    }
    return EXIT_OK;
  }

  private async addToGroup(
    ctx: CommandContext,
    req: ParsedAdduser,
    out: (t: string) => Promise<void>,
  ): Promise<ExitCode> {
    if (!(await ctx.machine.users.findByName(req.name))) {
      await out(`adduser: The user \`${req.name}' does not exist.`);
      return 1;
    }
    if (!(await ctx.machine.groups.findByName(req.group))) {
      await out(`adduser: The group \`${req.group}' does not exist.`);
      return 1;
    }
    ctx.machine.users.appendToGroup?.(req.name, req.group);
    await out(`Adding user \`${req.name}' to group \`${req.group}' ...`);
    await out('Done.');
    return EXIT_OK;
  }

  private async createGroup(
    ctx: CommandContext,
    req: ParsedAdduser,
    out: (t: string) => Promise<void>,
  ): Promise<ExitCode> {
    const cmd = this.commandName;
    if (!req.name) {
      await out(`${cmd}: missing group name`);
      return 1;
    }
    if (await ctx.machine.groups.findByName(req.name)) {
      await out(`${cmd}: The group \`${req.name}' already exists.`);
      return 1;
    }
    if (!ctx.machine.groups.posixGroupadd) {
      await out(`${cmd}: cannot lock /etc/group; try again later.`);
      return 1;
    }
    const result = ctx.machine.groups.posixGroupadd(req.name, req.gid);
    if (result) {
      await out(`${cmd}: ${result}`);
      return 1;
    }
    const group = await ctx.machine.groups.findByName(req.name);
    await out(`Adding group \`${req.name}' (GID ${group?.gid ?? req.gid ?? 0}) ...`);
    await out('Done.');
    return EXIT_OK;
  }

  private parse(tokens: string[]): ParsedAdduser {
    let groupMode = this.groupAlias;
    const req: ParsedAdduser = {
      mode: 'create-user',
      name: '',
      group: '',
      system: false,
      noCreateHome: false,
    };
    const positionals: string[] = [];

    const applyValue = (option: string, value: string) => {
      switch (option) {
        case '--uid': { const v = parseInt(value, 10); if (!Number.isNaN(v)) req.uid = v; break; }
        case '--gid': { const v = parseInt(value, 10); if (!Number.isNaN(v)) req.gid = v; break; }
        case '--ingroup': req.ingroup = value; break;
        case '--home': req.home = value; break;
        case '--shell': req.shell = value; break;
        case '--gecos': req.gecos = value; break;
      }
    };

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (BOOLEAN_OPTIONS.has(token)) {
        if (token === '--group') groupMode = true;
        else if (token === '--system') req.system = true;
        else if (token === '--no-create-home') req.noCreateHome = true;
        continue;
      }
      if (VALUE_OPTIONS.has(token)) {
        const value = tokens[++i];
        if (value !== undefined) applyValue(token, value);
        continue;
      }
      const eq = token.indexOf('=');
      if (token.startsWith('--') && eq > 0) {
        const name = token.slice(0, eq);
        if (VALUE_OPTIONS.has(name)) { applyValue(name, token.slice(eq + 1)); continue; }
        if (BOOLEAN_OPTIONS.has(name)) continue;
      }
      if (token.startsWith('-')) continue;
      positionals.push(token);
    }

    req.name = positionals[0] ?? '';
    req.group = positionals[1] ?? '';
    if (groupMode) req.mode = 'create-group';
    else if (req.group) req.mode = 'add-to-group';
    else req.mode = 'create-user';
    return req;
  }
}

export class AddgroupCommand extends AdduserCommand {
  override readonly descriptor: CommandDescriptor = {
    name: 'addgroup',
    summary: 'Add a group to the system (Debian front-end).',
    usage: 'addgroup [options] GROUP',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et nom de groupe' }],
    options: [],
    privileges: new RootWithVendorDenialPolicy('addgroup'),
    category: 'iam',
    lenientOptions: true,
  };

  protected override get groupAlias(): boolean { return true; }
  protected override get commandName(): string { return 'addgroup'; }
}
