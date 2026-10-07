export interface WinProgram {
  readonly directory: string;
  readonly file: string;
  readonly size: number;
}

type Entry = readonly [file: string, size: number];

function programsIn(directory: string, entries: readonly Entry[]): WinProgram[] {
  return entries.map(([file, size]) => ({ directory, file, size }));
}

export const WINDOWS_PROGRAMS: readonly WinProgram[] = [
  ...programsIn('C:\\Windows\\System32', [
    ['arp.exe', 29696], ['attrib.exe', 15872], ['auditpol.exe', 143360], ['certreq.exe', 355328],
    ['certutil.exe', 1488896], ['chcp.com', 12800], ['cmd.exe', 289792], ['comp.exe', 21504],
    ['curl.exe', 555008], ['dism.exe', 280064], ['doskey.exe', 15360], ['dsregcmd.exe', 245760],
    ['fc.exe', 30208], ['find.exe', 17920], ['findstr.exe', 32256], ['fsutil.exe', 124416],
    ['getmac.exe', 43520], ['gpresult.exe', 80384], ['gpupdate.exe', 64000], ['hostname.exe', 11264],
    ['icacls.exe', 88064], ['ipconfig.exe', 26624], ['klist.exe', 58880], ['logoff.exe', 15360],
    ['lpr.exe', 30208], ['more.com', 49152], ['nbtstat.exe', 33280], ['net.exe', 62464],
    ['net1.exe', 196608], ['netsh.exe', 96768], ['netstat.exe', 40448], ['nltest.exe', 99840],
    ['nslookup.exe', 80896], ['pathping.exe', 41472], ['ping.exe', 22528], ['print.exe', 18432],
    ['qwinsta.exe', 28160], ['query.exe', 15360], ['reg.exe', 88576], ['robocopy.exe', 190464],
    ['route.exe', 25600], ['runas.exe', 55808], ['rwinsta.exe', 15360], ['sc.exe', 73728],
    ['schtasks.exe', 244736], ['sfc.exe', 19456], ['shutdown.exe', 28672], ['sort.exe', 28672],
    ['systeminfo.exe', 105472], ['taskkill.exe', 80384], ['tasklist.exe', 79872], ['telnet.exe', 76800],
    ['tracert.exe', 13312], ['tzutil.exe', 19456], ['eventcreate.exe', 43008], ['w32tm.exe', 205312], ['wevtutil.exe', 156160], ['where.exe', 22016], ['whoami.exe', 71168],
    ['xcopy.exe', 51712],
  ]),
  ...programsIn('C:\\Windows\\System32\\OpenSSH', [
    ['scp.exe', 405504], ['sftp.exe', 442368], ['ssh-add.exe', 316416], ['ssh-agent.exe', 285184],
    ['ssh-keygen.exe', 502272], ['ssh-keyscan.exe', 332800], ['ssh.exe', 1002496],
  ]),
  ...programsIn('C:\\Windows\\System32\\wbem', [['wmic.exe', 47104]]),
  ...programsIn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0', [['powershell.exe', 452608]]),
];

const STEM_ALIASES: Readonly<Record<string, string>> = { net1: 'net' };

const STEM_BY_PATH = new Map(WINDOWS_PROGRAMS.map(program => {
  const stem = program.file.replace(/\.[^.]+$/, '').toLowerCase();
  return [`${program.directory}\\${program.file}`.toLowerCase(), STEM_ALIASES[stem] ?? stem];
}));

const PROGRAM_EXTENSION = /\.(exe|com)$/i;
const IMPLICIT_EXTENSIONS = ['.exe', '.com'];

export interface ProgramLookup {
  exists(path: string): boolean;
  normalize(path: string): string;
  searchDirectories(): string[];
}

export function programStem(lookup: ProgramLookup, token: string): string | null {
  const unquoted = token.replace(/^"(.*)"$/, '$1');
  const hasPath = /[\\/]/.test(unquoted) || /^[a-z]:/i.test(unquoted);
  const hasExtension = PROGRAM_EXTENSION.test(unquoted);
  if (!hasPath && !hasExtension) return null;
  const names = hasExtension ? [unquoted] : IMPLICIT_EXTENSIONS.map(extension => `${unquoted}${extension}`);
  const directories = hasPath ? [''] : ['', ...lookup.searchDirectories()];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = lookup.normalize(directory === '' ? name : `${directory.replace(/\\$/, '')}\\${name}`);
      if (lookup.exists(candidate)) return STEM_BY_PATH.get(candidate.toLowerCase()) ?? null;
    }
  }
  return null;
}
