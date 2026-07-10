import type { PSDeviceContext } from './PowerShellExecutor';

export interface PSDiagnosticContext {
  device: PSDeviceContext;
}

export async function handleTestConnection(ctx: PSDiagnosticContext, args: string[]): Promise<string> {
    let target = '', countStr = '4';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-ComputerName' && args[i + 1]) { target = args[++i]; }
      else if (args[i] === '-Count' && args[i + 1]) { countStr = args[++i]; }
      else if (!args[i].startsWith('-')) { target = args[i]; }
    }
    if (!target) return "Test-Connection : Parameter 'ComputerName' is required.";
    const count = Math.max(1, parseInt(countStr, 10) || 4);

    // Execute the underlying ping to get results
    const pingOutput = await ctx.device.executeCmdCommand(`ping -n ${count} ${target}`);

    // Transform CMD ping output to PS Test-Connection table format
    return formatTestConnection(ctx, pingOutput, target, count);
  }

export function formatTestConnection(ctx: PSDiagnosticContext, 
    pingOutput: string,
    target: string,
    count: number,
  ): string {
    const lines: string[] = [];
    const source = String(ctx.device.getHostname());

    // Parse Reply lines from CMD ping output
    const replyLines = pingOutput.split('\n').filter(l => l.trim().startsWith('Reply from'));

    const isLocalhost =
      target === 'localhost' ||
      target === '127.0.0.1' ||
      target.toLowerCase() === ctx.device.getHostname().toLowerCase();

    if (replyLines.length === 0 && !isLocalhost) {
      return `Test-Connection : Testing connection to computer '${target}' failed: host unreachable.\n    + CategoryInfo          : ResourceUnavailable: (${target}:String) [Test-Connection], PingException\n    + FullyQualifiedErrorId : TestConnectionException,Microsoft.PowerShell.Commands.TestConnectionCommand`;
    }

    lines.push('Source           Destination       IPV4Address      Bytes    Time(ms) Status');
    lines.push('------           -----------       -----------      -----    -------- ------');

    // Localhost path: simulated network can't actually ping itself, so
    // synthesize `count` rows matching real PowerShell behaviour.
    const effectiveReplies =
      isLocalhost && replyLines.length === 0
        ? Array.from(
            { length: count },
            () => 'Reply from 127.0.0.1: bytes=32 time<1ms TTL=128',
          )
        : replyLines;

    for (const line of effectiveReplies) {
      const ipMatch = line.match(/Reply from ([\d.]+)/);
      const timeMatch = line.match(/time[=<](\d+)/);
      const bytesMatch = line.match(/bytes=(\d+)/);
      const ip = ipMatch ? ipMatch[1] : (isLocalhost ? '127.0.0.1' : target);
      const time = timeMatch ? timeMatch[1] : '0';
      const bytes = bytesMatch ? bytesMatch[1] : '32';
      lines.push(
        `${source.padEnd(17)}${target.padEnd(18)}${ip.padEnd(17)}${bytes.padEnd(9)}${time.padEnd(9)}Success`
      );
    }

    return lines.join('\n');
  }

export function formatGetCimInstance(ctx: PSDiagnosticContext, args: string[]): string {
    const className = args.find(a => !a.startsWith('-')) || '';
    if (className.toLowerCase() === 'win32_operatingsystem') {
      return `SystemDirectory : C:\\Windows\\system32\nOrganization    : \nBuildNumber     : 22631\nRegisteredUser  : User\nSerialNumber    : 00000-00000-00000-AA000\nVersion         : 10.0.22631`;
    }
    if (className.toLowerCase() === 'win32_computersystem') {
      return `Domain              : WORKGROUP\nManufacturer        : Microsoft Corporation\nModel               : Virtual Machine\nName                : ${ctx.device.getHostname()}\nPrimaryOwnerName    : User\nTotalPhysicalMemory : 8589934592`;
    }
    return `Get-CimInstance : Invalid class "${className}"`;
  }
