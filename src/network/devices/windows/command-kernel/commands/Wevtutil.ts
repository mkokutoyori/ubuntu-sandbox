import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const WEVTUTIL_HELP = `Windows Events Command Line Utility.

Enables you to retrieve information about event logs and publishers, install
and uninstall event manifests, run queries, and export, archive, and clear logs.

Usage:

You can use either the short (for example, ep /uni) or long (for example,
enum-publishers /unicode) version of the command and option names. Commands,
options and option values are not case-sensitive.

Variables are noted in all upper-case.

wevtutil COMMAND [ARGUMENT [ARGUMENT] ...] [/OPTION:VALUE [/OPTION:VALUE] ...]

Commands:

el | enum-logs          List log names.
gl | get-log            Get log configuration information.
sl | set-log            Modify configuration of a log.
ep | enum-publishers    List event publishers.
gp | get-publisher      Get publisher configuration information.
im | install-manifest   Install event publishers and logs from manifest.
um | uninstall-manifest Uninstall event publishers and logs from manifest.
qe | query-events       Query events from a log or log file.
gli | get-log-info      Get log status information.
epl | export-log        Export a log.
al | archive-log        Archive an exported log.
cl | clear-log          Clear a log.

Common options:

/{r | remote}:VALUE
If specified, run the command on a remote computer. VALUE is the remote computer
name. Options /u and /p do not apply to all commands.`;

const DHCP_EVENT_IDS: Record<string, number> = {
  INIT: 1000, DISCOVER: 1001, OFFER: 1002, REQUEST: 1003,
  ACK: 1004, RELEASE: 1005, NAK: 1006, RENEW: 1007, RESET: 1008,
};

export class WevtutilCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'wevtutil',
    summary: 'Utilitaire de journal d\'évènements Windows',
    usage: WEVTUTIL_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'commande et arguments wevtutil' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.includes('/?') || args.includes('/help') || args.length === 0) {
      await ctx.io.stdout.write(WEVTUTIL_HELP + '\n');
      return EXIT_OK;
    }
    if (!ctx.machine.eventLog) {
      await ctx.io.stdout.write('WEVTUTIL: not supported on this device\n');
      return 1;
    }

    // Toute interrogation/mutation exige le service Journal d'évènements Windows.
    if (!ctx.machine.services?.isRunning('EventLog')) {
      await ctx.io.stdout.write('Failed to query events. The Windows Event Log service is not running.\n');
      return 1;
    }

    const eventLog = ctx.machine.eventLog;
    const verb = args[0].toLowerCase();
    const joined = args.join(' ');
    let out: string;

    if (verb === 'qe' || verb === 'query-events') {
      if (joined.toLowerCase().includes('dhcp')) {
        out = this.queryDhcpEvents(ctx, joined);
      } else {
        const logName = args[1];
        const entries = logName ? eventLog.entries(logName) : null;
        if (!entries || entries.length === 0) {
          out = 'No events found that match the specified selection criteria.';
        } else {
          out = entries.map((e, i) =>
            `Event[${i}]:\n  Log Name: ${logName}\n  Source: ${e.source}\n` +
            `  Event ID: ${e.eventId}\n  Description: ${e.message}`,
          ).join('\n\n');
        }
      }
    } else if (verb === 'el' || verb === 'enum-logs') {
      out = 'Application\nSecurity\nSetup\nSystem\nForwardedEvents';
    } else if (verb === 'cl' || verb === 'clear-log') {
      out = args[1] ? `The ${args[1]} log has been cleared successfully.` : 'Usage: wevtutil cl <log>';
    } else {
      out = WEVTUTIL_HELP;
    }

    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }

  private queryDhcpEvents(ctx: CommandContext, joined: string): string {
    const eventLog = ctx.machine.eventLog!;
    const countMatch = joined.match(/\/c:(\d+)/);
    const maxCount = countMatch ? parseInt(countMatch[1], 10) : 10;

    eventLog.ensureDhcpInitEvent();
    const events = eventLog.dhcpEventLog().slice(-maxCount);

    const lines: string[] = [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const typeMatch = event.match(/DHCP (\w+):/);
      const type = typeMatch ? typeMatch[1] : 'INFO';
      const eventId = DHCP_EVENT_IDS[type] || 1000;
      const dateMatch = event.match(/^\[([^\]]+)\]/);
      const date = dateMatch ? dateMatch[1] : new Date().toISOString();

      lines.push(`Event[${i}]:`);
      lines.push(`  Log Name: System`);
      lines.push(`  Source: Microsoft-Windows-Dhcp-Client`);
      lines.push(`  Date: ${date}`);
      lines.push(`  Event ID: ${eventId}`);
      lines.push(`  Description: ${event.replace(/^\[[^\]]+\]\s*/, '')}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}
