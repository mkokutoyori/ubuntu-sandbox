/**
 * WinDsregcmd — `dsregcmd /status` (PRD-Windows-Server-Advanced.md §5 P13,
 * §2.1.13, Windows Hello for Business join-state diagnostics). Only the
 * fields this simulator's PassportForWork GPO policy actually drives are
 * real: DomainJoined mirrors the real domain-join state, and
 * HelloIsEnabled/NgcKeyRegistered mirror whether `PassportForWork\Enabled`
 * was pushed by `gpupdate`. Real dsregcmd also enrolls Hello interactively
 * (PIN creation, TPM key generation) — this simulator has no such
 * interactive flow, so a domain-joined machine with the policy applied is
 * treated as already "enrolled", matching the class of policy-driven
 * simplification already used elsewhere (e.g. WHfB has no PIN UX to model).
 */

export interface DsregcmdContext {
  readonly domainJoined: boolean;
  readonly domainNetbiosName: string | null;
  readonly domainDnsName: string | null;
  readonly hostname: string;
  readonly currentUser: string;
  readonly helloEnabledByPolicy: boolean;
}

export function cmdDsregcmd(ctx: DsregcmdContext, args: string[]): string {
  const sub = (args[0] ?? '').replace(/^\//, '').toLowerCase();
  if (sub !== 'status' && sub !== '') {
    return `dsregcmd : '${args[0]}' is not a recognized dsregcmd command.\nUsage: dsregcmd /status`;
  }

  const yn = (b: boolean) => (b ? 'YES' : 'NO');
  const lines: string[] = [];

  lines.push('');
  lines.push('+----------------------------------------------------------------+');
  lines.push('| Device State                                                    |');
  lines.push('+----------------------------------------------------------------+');
  lines.push('');
  lines.push('             AzureAdJoined : NO');
  lines.push('          EnterpriseJoined : NO');
  lines.push(`              DomainJoined : ${yn(ctx.domainJoined)}`);
  if (ctx.domainJoined) {
    lines.push(`                DomainName : ${ctx.domainNetbiosName ?? ''}`);
  }
  lines.push('');

  lines.push('+----------------------------------------------------------------+');
  lines.push('| Device Details                                                  |');
  lines.push('+----------------------------------------------------------------+');
  lines.push('');
  lines.push(`                 DeviceName : ${ctx.hostname}`);
  lines.push('');

  lines.push('+----------------------------------------------------------------+');
  lines.push('| User State                                                      |');
  lines.push('+----------------------------------------------------------------+');
  lines.push('');
  lines.push(`                   NgcSet : ${yn(ctx.domainJoined && ctx.helloEnabledByPolicy)}`);
  lines.push(`         WorkplaceJoined : NO`);
  lines.push('');

  lines.push('+----------------------------------------------------------------+');
  lines.push('| Ngc Prerequisite Check                                          |');
  lines.push('+----------------------------------------------------------------+');
  lines.push('');
  lines.push(`             IsDeviceJoined : ${yn(ctx.domainJoined)}`);
  lines.push(`             PolicyEnabled : ${yn(ctx.helloEnabledByPolicy)}`);
  lines.push(`             DeviceEligible : ${yn(ctx.domainJoined)}`);
  lines.push('');

  lines.push('+----------------------------------------------------------------+');
  lines.push('| Ngc State                                                       |');
  lines.push('+----------------------------------------------------------------+');
  lines.push('');
  lines.push(`            HelloIsEnabled : ${yn(ctx.helloEnabledByPolicy)}`);
  lines.push(`        NgcKeyRegistered : ${yn(ctx.domainJoined && ctx.helloEnabledByPolicy)}`);
  lines.push('');

  return lines.join('\n');
}
