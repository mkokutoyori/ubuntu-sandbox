import { helpFor } from './CmdletHelp';

export interface HelpRenderOptions {
  examples?: boolean;
  detailed?: boolean;
  full?: boolean;
  parameter?: string;
  online?: boolean;
  showWindow?: boolean;
}

const TECHNET = 'https://go.microsoft.com/fwlink/?LinkID=107116';

export function helpTopicNotFound(topic: string): string {
  return `Get-Help : Get-Help could not find ${topic} in a help file in this session. `
    + `To download updated help topics type: "Update-Help". To get help online, search for `
    + `the help topic in the TechNet library at ${TECHNET}.`;
}

export const HELP_SYSTEM_TOPIC = [
  'TOPIC',
  '    Windows PowerShell Help System',
  '',
  'SHORT DESCRIPTION',
  '    Displays help about Windows PowerShell cmdlets and concepts.',
  '',
  'LONG DESCRIPTION',
  '    Windows PowerShell Help describes cmdlets, functions, scripts, and modules.',
  '',
  '    To get help for a cmdlet, type: Get-Help <cmdlet-name>',
].join('\n');

export function renderCmdletHelp(topic: string, opts?: HelpRenderOptions): string | null {
  const entry = helpFor(topic);
  if (!entry) return null;

  if (opts?.showWindow) {
    return `Get-Help : The -ShowWindow parameter is not supported in this simulator.\n`
      + `    Use Get-Help ${topic} to view help in the terminal.`;
  }
  if (opts?.online) {
    return `Opening online help for ${topic}... (simulated: no browser in simulator)`;
  }
  if (opts?.parameter) {
    return `PARAMETER: -${opts.parameter}\n\nName: -${opts.parameter}\n    ${entry.parameters ?? '(no parameter info)'}`;
  }

  const lines: string[] = [
    'NAME',
    `    ${topic}`,
    '',
    'SYNOPSIS',
    `    ${entry.synopsis}`,
    '',
    'SYNTAX',
    `    ${entry.syntax}`,
    '',
    'DESCRIPTION',
    `    ${entry.description}`,
  ];

  if ((opts?.examples || opts?.detailed || opts?.full) && entry.examples) {
    lines.push('', 'EXAMPLES', `    ${entry.examples}`);
  }
  if ((opts?.detailed || opts?.full) && entry.parameters) {
    lines.push('', 'PARAMETERS', `    ${entry.parameters}`);
  }
  if (opts?.full) {
    lines.push('', 'INPUTS', `    None. You cannot pipe objects to ${topic}.`);
    lines.push('', 'OUTPUTS', '    System.Object');
    lines.push('', 'NOTES', '    This is a simulated cmdlet.');
  }
  lines.push('', 'RELATED LINKS', `    Get-Help ${topic} -Online`);
  lines.push('', 'REMARKS',
    `    To see the examples, type: "Get-Help ${topic} -Examples"`,
    `    For more information, type: "Get-Help ${topic} -Detailed"`,
    `    For technical information, type: "Get-Help ${topic} -Full"`);

  return lines.join('\n');
}
