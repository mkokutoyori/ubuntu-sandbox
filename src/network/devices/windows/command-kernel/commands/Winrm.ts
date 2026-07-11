import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class WinrmCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'winrm',
    summary: 'Configure et interroge le service Windows Remote Management',
    usage: 'winrm quickconfig|enumerate|get|set [options]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande winrm' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.winRm) {
      await ctx.io.stdout.write('WINRM: not supported on this device\n');
      return 1;
    }
    const sub = (args[0] ?? '').toLowerCase();

    if (sub === 'quickconfig' || sub === 'qc') {
      if (ctx.machine.winRm.isEnabled()) {
        await ctx.io.stdout.write('WinRM service is already running on this machine.\nWinRM is already set up to receive requests on this machine.\n');
        return EXIT_OK;
      }
      ctx.machine.winRm.enable();
      await ctx.io.stdout.write([
        'WinRM service is not running on this machine.',
        'WinRM service started.',
        'WinRM is not set up to allow remote access to this machine for management.',
        'The following changes must be made:',
        '',
        'Create a WinRM listener on HTTP://* to accept WS-Man requests to any IP on this machine.',
        '',
        'WinRM has been updated to receive requests.',
        'A listener has been created on this machine for the HTTP protocol using address * with port 5985.',
      ].join('\n') + '\n');
      return EXIT_OK;
    }

    if (sub === 'enumerate') {
      const target = (args[1] ?? '').toLowerCase();
      if (target === 'winrm/config/listener') {
        const listeners = ctx.machine.winRm.listeners();
        if (listeners.length === 0) {
          await ctx.io.stdout.write('WSManFault\n    Message = No listeners were found that are compatible with the request.\n');
          return EXIT_OK;
        }
        await ctx.io.stdout.write(listeners.map((l) => [
          'Listener',
          '    Address = *',
          `    Transport = ${l.transport}`,
          `    Port = ${l.port}`,
          '    Hostname',
          '    Enabled = true',
          '    URLPrefix = wsman',
          '    CertificateThumbprint',
          '    ListeningOn = 0.0.0.0',
        ].join('\n')).join('\n\n') + '\n');
        return EXIT_OK;
      }
    }

    await ctx.io.stdout.write('WinRM command not recognized.\n');
    return 1;
  }
}
