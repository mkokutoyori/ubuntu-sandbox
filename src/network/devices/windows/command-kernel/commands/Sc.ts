import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { ServiceManagementApi } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const NOT_FOUND = '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.';
const NOT_FOUND_OPEN = '[SC] OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.';

/** Parse "key= value" pairs as used by sc.exe */
function parseScOptions(args: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].toLowerCase();
    if (key.endsWith('=')) {
      const val = args[i + 1] || '';
      result[key.slice(0, -1).replace(/\s/g, '')] = val.replace(/^["']|["']$/g, '');
      i++;
    } else if (key.includes('=')) {
      const [k, ...v] = key.split('=');
      result[k.replace(/\s/g, '')] = v.join('=').replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

/** Parse `restart/10000/run/20000/reboot/30000` into ordered recovery tiers. */
function parseFailureActions(raw: string): { type: 'restart' | 'run' | 'reboot' | 'none'; delayMs: number }[] {
  const tokens = raw.split('/');
  const out: { type: 'restart' | 'run' | 'reboot' | 'none'; delayMs: number }[] = [];
  const validTypes = ['restart', 'run', 'reboot', 'none'];
  for (let i = 0; i < tokens.length; i += 2) {
    const type = tokens[i].toLowerCase();
    if (!validTypes.includes(type)) continue;
    const delayMs = parseInt(tokens[i + 1] ?? '0', 10);
    out.push({ type: type as 'restart' | 'run' | 'reboot' | 'none', delayMs: isNaN(delayMs) ? 0 : delayMs });
  }
  return out;
}

export class ScCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sc',
    aliases: ['sc.exe'],
    summary: 'Contrôle les services Windows',
    usage: 'sc <query|start|stop|config|...> <service>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande sc' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  private query(services: ServiceManagementApi, args: readonly string[]): string {
    if (args.length >= 1 && args[0].toLowerCase().startsWith('type=')) {
      return services.formatQueryAll().join('\n\n');
    }
    if (args.length === 0) return services.formatQueryAllRunning().join('\n\n');
    const formatted = services.formatQuery(args[0]);
    return formatted ?? NOT_FOUND;
  }

  private queryEx(services: ServiceManagementApi, args: readonly string[]): string {
    if (args.length >= 1 && args[0].toLowerCase().startsWith('type=')) {
      return services.formatQueryExAll().join('\n\n');
    }
    if (args.length === 0) return services.formatQueryExAllRunning().join('\n\n');
    const formatted = services.formatQueryEx(args[0]);
    return formatted ?? NOT_FOUND;
  }

  private qc(services: ServiceManagementApi, args: readonly string[]): string {
    if (args.length === 0) return '[SC] QueryServiceConfig FAILED: service name required.';
    return services.formatQc(args[0]) ?? NOT_FOUND_OPEN;
  }

  private start(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] StartService: service name required.';
    const result = services.start(args[0], isAdmin);
    if (!result.ok) {
      const err = result.error!;
      if (err.includes('FAILED 1060')) return err;
      if (err.includes('disabled')) return `[SC] StartService FAILED 1058:\n\n${err}`;
      if (err.includes('already running')) return `[SC] StartService FAILED 1056:\n\n${err}`;
      return `[SC] StartService FAILED:\n\n${err}`;
    }
    return result.formattedStatus!;
  }

  private stop(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] ControlService: service name required.';
    const result = services.stop(args[0], isAdmin);
    if (!result.ok) {
      const err = result.error!;
      if (err.includes('FAILED 1060')) return err;
      if (err.includes('not been started')) return `[SC] ControlService FAILED 1062:\n\n${err}`;
      if (err.includes('dependent') || err.includes('Cannot stop')) return `[SC] ControlService FAILED 1051:\n\n${err}`;
      return `[SC] ControlService FAILED:\n\n${err}`;
    }
    return result.formattedStatus!;
  }

  private pause(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] ControlService: service name required.';
    const result = services.pause(args[0], isAdmin);
    if (!result.ok) {
      const err = result.error!;
      if (err.includes('cannot be paused')) return `[SC] ControlService FAILED 1052:\n\n${err}`;
      if (err.includes('not running')) return `[SC] ControlService FAILED 1062:\n\n${err}`;
      return `[SC] ControlService FAILED:\n\n${err}`;
    }
    return result.formattedStatus!;
  }

  private continue(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] ControlService: service name required.';
    const result = services.resume(args[0], isAdmin);
    if (!result.ok) {
      const err = result.error!;
      if (err.includes('not paused')) return `[SC] ControlService FAILED 1053:\n\n${err}`;
      return `[SC] ControlService FAILED:\n\n${err}`;
    }
    return result.formattedStatus!;
  }

  private config(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean, currentUser: string): string {
    if (args.length < 2) return '[SC] ChangeServiceConfig: service name and option required.';
    const name = args[0];
    const opts = parseScOptions(args.slice(1));

    if (opts.start) {
      const typeMap: Record<string, 'Automatic' | 'Manual' | 'Disabled'> = { auto: 'Automatic', demand: 'Manual', disabled: 'Disabled' };
      const startType = typeMap[opts.start.toLowerCase()];
      if (!startType) return `[SC] ChangeServiceConfig FAILED: Invalid start type "${opts.start}".`;
      const result = services.setStartType(name, startType, isAdmin);
      if (!result.ok) return `[SC] ChangeServiceConfig FAILED:\n\n${result.error}`;
    }
    if (opts.depend !== undefined) {
      const deps = opts.depend.split('/').map((s) => s.trim()).filter(Boolean);
      const result = services.setDependencies(name, deps, isAdmin);
      if (!result.ok) return `[SC] ChangeServiceConfig FAILED:\n\n${result.error}`;
    }
    if (opts.obj !== undefined) {
      const result = services.setAccount(name, opts.obj, isAdmin, currentUser);
      if (!result.ok) return `[SC] ChangeServiceConfig FAILED:\n\n${result.error}`;
    }
    return '[SC] ChangeServiceConfig SUCCESS';
  }

  private create(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean, currentUser: string): string {
    if (args.length < 2) return '[SC] CreateService: service name and binPath= required.';
    const name = args[0];
    const opts = parseScOptions(args.slice(1));
    if (!opts.binpath) return '[SC] CreateService FAILED: binPath= is required.';

    const startTypeMap: Record<string, 'Automatic' | 'Manual' | 'Disabled'> = { auto: 'Automatic', demand: 'Manual', disabled: 'Disabled' };
    const result = services.create(name, {
      binaryPath: opts.binpath,
      displayName: opts.displayname || name,
      startType: opts.start ? startTypeMap[opts.start.toLowerCase()] : undefined,
      dependencies: opts.depend ? opts.depend.split('/').map((s) => s.trim()).filter(Boolean) : undefined,
    }, isAdmin, currentUser);

    if (!result.ok) {
      if (result.error?.includes('already exists')) return `[SC] CreateService FAILED 1073:\n\n${result.error}`;
      return `[SC] CreateService FAILED:\n\n${result.error}`;
    }
    return '[SC] CreateService SUCCESS';
  }

  private delete(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] DeleteService: service name required.';
    const result = services.delete(args[0], isAdmin);
    if (!result.ok) {
      if (result.error?.includes('must be stopped')) return '[SC] DeleteService FAILED 1072:\n\nThe service must be stopped before deleting.';
      return `[SC] DeleteService FAILED:\n\n${result.error}`;
    }
    return '[SC] DeleteService SUCCESS';
  }

  private description(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] QueryServiceConfig2: service name required.';
    if (!services.exists(args[0])) return NOT_FOUND_OPEN;
    if (args.length >= 2) {
      const desc = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
      const result = services.setDescription(args[0], desc, isAdmin);
      if (!result.ok) return `[SC] ChangeServiceConfig2 FAILED:\n\n${result.error}`;
      return '[SC] ChangeServiceConfig2 SUCCESS';
    }
    return services.formatDescription(args[0])!;
  }

  private qfailure(services: ServiceManagementApi, args: readonly string[]): string {
    if (args.length === 0) return '[SC] QueryServiceConfig2: service name required.';
    return services.formatQfailure(args[0]) ?? NOT_FOUND_OPEN;
  }

  private failure(services: ServiceManagementApi, args: readonly string[], isAdmin: boolean): string {
    if (args.length === 0) return '[SC] ChangeServiceConfig2: service name required.';
    const name = args[0];
    if (!services.exists(name)) return NOT_FOUND_OPEN;
    const opts = parseScOptions(args.slice(1));
    const resetPeriodSec = opts.reset ? parseInt(opts.reset, 10) : 0;
    const result = services.setFailureConfig(name, {
      resetPeriodSec: isNaN(resetPeriodSec) ? 0 : resetPeriodSec,
      actions: opts.actions ? parseFailureActions(opts.actions) : [],
      command: opts.command || undefined,
    }, isAdmin);
    if (!result.ok) return `[SC] ChangeServiceConfig2 FAILED:\n\n${result.error}`;
    return '[SC] ChangeServiceConfig2 SUCCESS';
  }

  private sdshow(services: ServiceManagementApi, args: readonly string[]): string {
    if (args.length === 0) return '[SC] OpenService: service name required.';
    if (!services.exists(args[0])) return NOT_FOUND_OPEN;
    // Realistic SDDL string matching Windows defaults (canned, not per-service vendor data).
    return '\nD:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)';
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const services = ctx.machine.services;
    if (!services) {
      await ctx.io.stdout.write('SC: not supported on this device\n');
      return 1;
    }
    if (args.length === 0) {
      await ctx.io.stdout.write('DESCRIPTION:\n        SC is a command line program used for communicating with the\n        Service Control Manager and services.\nUSAGE:\n        sc <server> [command] [service name] <option1> <option2>...\n');
      return 1;
    }

    const isAdmin = ctx.session.user.isRoot();
    const currentUser = ctx.session.user.name;
    const subCmd = args[0].toLowerCase();
    const subArgs = args.slice(1);

    let output: string;
    switch (subCmd) {
      case 'query': output = this.query(services, subArgs); break;
      case 'queryex': output = this.queryEx(services, subArgs); break;
      case 'qc': output = this.qc(services, subArgs); break;
      case 'start': output = this.start(services, subArgs, isAdmin); break;
      case 'stop': output = this.stop(services, subArgs, isAdmin); break;
      case 'pause': output = this.pause(services, subArgs, isAdmin); break;
      case 'continue': output = this.continue(services, subArgs, isAdmin); break;
      case 'config': output = this.config(services, subArgs, isAdmin, currentUser); break;
      case 'create': output = this.create(services, subArgs, isAdmin, currentUser); break;
      case 'delete': output = this.delete(services, subArgs, isAdmin); break;
      case 'description': output = this.description(services, subArgs, isAdmin); break;
      case 'qfailure': output = this.qfailure(services, subArgs); break;
      case 'failure': output = this.failure(services, subArgs, isAdmin); break;
      case 'sdshow': output = this.sdshow(services, subArgs); break;
      default: output = `[SC] Unrecognized command "${subCmd}"`; break;
    }

    await ctx.io.stdout.write(output + '\n');
    return EXIT_OK;
  }
}
