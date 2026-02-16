/**
 * Windows WEVTUTIL command — Windows Event Log utility.
 *
 * Supported:
 *   wevtutil qe System /q:"..Dhcp-Client.." /f:text /c:N  — query DHCP events
 *   wevtutil /?                                             — usage help
 */

import type { WinCommandContext } from './WinCommandExecutor';

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

export function cmdWevtutil(ctx: WinCommandContext, args: string[]): string {
  if (args.includes('/?') || args.includes('/help') || args.length === 0) {
    return WEVTUTIL_HELP;
  }

  const joined = args.join(' ');

  // wevtutil qe System /q:"..dhcp.." /f:text /c:N
  if (args[0].toLowerCase() === 'qe' || args[0].toLowerCase() === 'query-events') {
    if (joined.toLowerCase().includes('dhcp-client') || joined.toLowerCase().includes('dhcp')) {
      return queryDHCPEvents(ctx, joined);
    }
    // Generic query
    return 'No events found that match the specified selection criteria.';
  }

  // wevtutil el
  if (args[0].toLowerCase() === 'el' || args[0].toLowerCase() === 'enum-logs') {
    return 'Application\nSecurity\nSetup\nSystem\nForwardedEvents';
  }

  // wevtutil cl <log>
  if (args[0].toLowerCase() === 'cl' || args[0].toLowerCase() === 'clear-log') {
    return args[1] ? `The ${args[1]} log has been cleared successfully.` : 'Usage: wevtutil cl <log>';
  }

  return WEVTUTIL_HELP;
}

function queryDHCPEvents(ctx: WinCommandContext, joined: string): string {
  const countMatch = joined.match(/\/c:(\d+)/);
  const maxCount = countMatch ? parseInt(countMatch[1], 10) : 10;

  ctx.syncDHCPEvents();

  const eventLog = ctx.getDHCPEventLog();
  if (eventLog.length === 0) {
    ctx.addDHCPEvent('INIT', 'Dhcp-Client service initialized');
  }

  const events = ctx.getDHCPEventLog().slice(-maxCount);
  const eventIDs: Record<string, number> = {
    'INIT': 1000, 'DISCOVER': 1001, 'OFFER': 1002,
    'REQUEST': 1003, 'ACK': 1004, 'RELEASE': 1005,
    'NAK': 1006, 'RENEW': 1007, 'RESET': 1008,
  };

  const lines: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const typeMatch = event.match(/DHCP (\w+):/);
    const type = typeMatch ? typeMatch[1] : 'INFO';
    const eventId = eventIDs[type] || 1000;
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
