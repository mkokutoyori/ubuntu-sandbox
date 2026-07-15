import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { requireInteraction } from '@/command-kernel/io/interaction';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import type { SftpConnectResult } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

interface ParsedSftpArgs {
  readonly userAtHost: string;
  readonly batchFile?: string;
  readonly port?: number;
}

/**
 * `sftp [-b batchfile] [-P port] [user@]host` — lanceur SFTP (framework
 * §14.6 Push C). Parsing, dialogue mot de passe (`ctx.io.interaction`,
 * comme `adduser`) et remise du sous-shell (`ctx.io.openSubShell`,
 * framework §5.5) vivent entièrement ici ; la connexion réelle (SSH + canal
 * SFTP) et l'exécution des lignes de la grammaire sftp en mode batch
 * délèguent à `machine.sftpConnect` — jamais une seconde implémentation du
 * protocole ou du shell sftp interne (déjà en command-kernel, Push A/B).
 */
export class SftpLauncherCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sftp',
    summary: 'OpenSSH secure file transfer client.',
    usage: 'sftp [-b batchfile] [-P port] [user@]host[:path]',
    args: [{ name: 'argv', type: 'string', required: false, variadic: true, description: 'options et cible (grammaire sftp(1), analysée par la commande)' }],
    options: [],
    privileges: ANY,
    category: 'network',
    lenientOptions: true,
    // Le mot de passe précède toute sortie de bienvenue : sans diffusion en
    // direct, la bannière `Connected to ...` resterait invisible jusqu'à la
    // fin du dialogue (même raison que adduser, framework §14.6).
    streaming: true,
  };

  private parse(tokens: readonly string[]): ParsedSftpArgs | null {
    let batchFile: string | undefined;
    let port: number | undefined;
    const positional: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '-b' && i + 1 < tokens.length) { batchFile = tokens[++i]; continue; }
      if (token === '-P' && i + 1 < tokens.length) {
        const parsed = Number.parseInt(tokens[++i], 10);
        if (!Number.isNaN(parsed)) port = parsed;
        continue;
      }
      if (token.startsWith('-')) continue;
      positional.push(token);
    }
    const userAtHost = positional[0];
    if (!userAtHost) return null;
    return { userAtHost, batchFile, port };
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const out = (text: string) => ctx.io.stdout.write(`${text}\n`);
    const parsed = this.parse(ctx.rawArgv);
    if (!parsed) {
      await out('usage: sftp [-b batchfile] [-P port] [user@]host[:path]');
      return 1;
    }

    const connectApi = ctx.machine.sftpConnect;
    if (!connectApi) {
      await out('sftp: this device does not support SFTP');
      return 1;
    }

    const user = parsed.userAtHost.includes('@') ? parsed.userAtHost.split('@')[0] : ctx.session.user.name;
    const host = parsed.userAtHost.includes('@') ? parsed.userAtHost.split('@')[1] : parsed.userAtHost;
    const displayTarget = `${user}@${host}`;

    const ui = requireInteraction(ctx.io, 'sftp');
    const password = (await ui.prompt({ kind: 'secret', prompt: `${displayTarget}'s password: ` })) ?? '';

    const result = await connectApi.connect(parsed.userAtHost, password, { port: parsed.port, localCwd: ctx.session.cwd });
    if (!result.ok) {
      await out(result.banner);
      return 1;
    }
    await out(result.banner);

    if (parsed.batchFile) {
      return this.runBatch(ctx, result, parsed.batchFile, out);
    }

    if (!ctx.io.openSubShell) {
      result.disconnect?.();
      await out('sftp: interactive session unavailable in this context');
      return 1;
    }
    ctx.io.openSubShell('sftp', result.handle);
    return EXIT_OK;
  }

  /**
   * Mode batch (`-b`) : chaque ligne non vide/non-commentaire du fichier
   * est échouée avec le prompt sftp puis exécutée sur la connexion déjà
   * ouverte — un préfixe `-` rend l'erreur non bloquante (parité OpenSSH),
   * sinon une erreur arrête le batch. Aucun sous-shell interactif n'est
   * ouvert : la connexion est fermée à la fin.
   */
  private async runBatch(
    ctx: CommandContext,
    result: SftpConnectResult,
    batchFile: string,
    out: (t: string) => Promise<void>,
  ): Promise<ExitCode> {
    const prompt = result.prompt ?? 'sftp> ';
    let content: string;
    try {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, batchFile);
      content = await ctx.machine.fs.readFile(path, toFileSystemActor(ctx.session.user));
    } catch {
      await out(`Couldn't open batch file ${batchFile}`);
      result.disconnect?.();
      return 1;
    }

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const ignoreErrors = line.startsWith('-');
      const cmd = ignoreErrors ? line.slice(1).trim() : line;
      await out(`${prompt}${cmd}`);
      const lineResult = await result.runLine!(cmd);
      for (const line2 of lineResult.output) if (line2) await out(line2);
      if (lineResult.exit) break;
      if (!ignoreErrors && hasSftpError(lineResult.output)) break;
    }
    result.disconnect?.();
    return EXIT_OK;
  }
}

function hasSftpError(output: readonly string[]): boolean {
  return output.some((line) =>
    /Couldn't|No such file|Permission denied|Failure|invalid|command not found/i.test(line),
  );
}
