import { md5Hex, sha1Hex, sha256Hex } from '@/crypto/hash';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * Base commune à `md5sum`/`sha1sum`/`sha256sum` — même surface (calcul en
 * mode direct, vérification `-c`), seule la fonction de hachage pure change.
 * La lecture des fichiers passe par `ctx.machine.fs` ; les fonctions de
 * hachage restent partagées (`@/crypto/hash`), pas resimulées.
 */
abstract class ChecksumCommand extends BaseCommand {
  protected abstract readonly cmdName: string;
  protected abstract hash(content: string): string;

  get descriptor(): CommandDescriptor {
    return {
      name: this.cmdName,
      summary: 'Calcule ou vérifie une empreinte de fichier',
      usage: `${this.cmdName} [-c] FICHIER...`,
      args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'fichiers (ou fichier de sommes avec -c)' }],
      options: [],
      privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
      category: 'fichiers',
      lenientOptions: true,
    };
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const checkMode = operands.includes('-c') || operands.includes('--check');
    const targets = operands.filter((a) => !a.startsWith('-'));
    if (targets.length === 0) {
      await ctx.io.stdout.write(`${this.cmdName}: missing file operand\n`);
      return 1;
    }
    const actor = toFileSystemActor(ctx.session.user);
    const read = async (rel: string): Promise<string | null> => {
      try {
        return await ctx.machine.fs.readFile(ctx.machine.fs.resolve(ctx.session.cwd, rel), actor);
      } catch {
        return null;
      }
    };

    if (checkMode) {
      const checksumFile = await read(targets[0]);
      if (checksumFile === null) {
        await ctx.io.stdout.write(`${this.cmdName}: ${targets[0]}: No such file or directory\n`);
        return 1;
      }
      const results: string[] = [];
      let failed = 0;
      for (const line of checksumFile.split('\n').filter((l) => l.trim())) {
        const m = line.match(/^([0-9a-f]+)\s+(.+)$/);
        if (!m) continue;
        const [, expectedHash, filePath] = m;
        const content = await read(filePath);
        if (content === null) { results.push(`${filePath}: FAILED open or read`); failed++; continue; }
        if (this.hash(content) === expectedHash) results.push(`${filePath}: OK`);
        else { results.push(`${filePath}: FAILED`); failed++; }
      }
      if (failed) results.push(`${this.cmdName}: WARNING: ${failed} computed checksum did NOT match`);
      await ctx.io.stdout.write(results.join('\n') + '\n');
      return failed ? 1 : 0;
    }

    const lines: string[] = [];
    for (const target of targets) {
      const content = await read(target);
      if (content === null) { lines.push(`${this.cmdName}: ${target}: No such file or directory`); continue; }
      lines.push(`${this.hash(content)}  ${target}`);
    }
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
}

export class Md5sumCommand extends ChecksumCommand {
  protected readonly cmdName = 'md5sum';
  protected hash(content: string): string { return md5Hex(content); }
}

export class Sha1sumCommand extends ChecksumCommand {
  protected readonly cmdName = 'sha1sum';
  protected hash(content: string): string { return sha1Hex(content); }
}

export class Sha256sumCommand extends ChecksumCommand {
  protected readonly cmdName = 'sha256sum';
  protected hash(content: string): string { return sha256Hex(content); }
}
