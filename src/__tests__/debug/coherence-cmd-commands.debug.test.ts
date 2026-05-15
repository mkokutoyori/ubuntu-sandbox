/**
 * Debug run — every cmd.exe builtin / native, executed in BOTH cmd
 * and PowerShell.
 *
 * PowerShell is a strict super-set of cmd in our simulator: anything
 * that runs in cmd MUST also run when typed at the PS prompt (either
 * because PS surfaces the native binary or because there is a PS-
 * native cmdlet aliased to the same token, e.g. `dir`, `cd`, `cls`).
 *
 * For each cmd command we run it twice (once in each shell) and
 * dump both outputs side-by-side in the transcript so divergence is
 * trivial to spot.
 *
 * Transcripts →
 *   debug-output/coherence-cmd-commands-pc_results_debug.txt
 *   debug-output/coherence-cmd-commands-server_results_debug.txt
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  runCoherenceDump,
  createPSRunner,
  createCmdRunner,
  type CoherenceCommand,
} from './_dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

/**
 * Build a pair of coherence entries for the same cmd-style command:
 * once via the cmd runner, then via the PS runner.  The section
 * header is set on the first entry only.
 */
function mirror(cmd: string, section?: string): CoherenceCommand[] {
  return [
    { section, shell: 'cmd', cmd },
    { shell: 'ps', cmd },
  ];
}

describe('debug — cmd-style commands run identically in PowerShell', () => {
  it('mirrors every cmd builtin/native through PowerShell', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-CMD-COH');
    const srv = new WindowsPC('windows-server', 'SRV-CMD-COH');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');

    const commands: CoherenceCommand[] = [
      // ── Section 1: basic shell builtins ─────────────────────────
      ...mirror('echo hello world',            'echo / output'),
      ...mirror('echo %COMPUTERNAME%'),
      ...mirror('echo %USERNAME%'),
      ...mirror('echo %CD%'),
      ...mirror('ver',                         'ver / version'),
      ...mirror('hostname'),
      ...mirror('whoami'),
      ...mirror('whoami /user'),
      ...mirror('date /t'),
      ...mirror('time /t'),

      // ── Section 2: filesystem (cd / dir / type / md / rd) ───────
      ...mirror('cd C:\\',                     'filesystem builtins'),
      ...mirror('cd'),
      ...mirror('dir C:\\'),
      ...mirror('dir C:\\ /b'),
      ...mirror('dir C:\\ /s /b', undefined),
      ...mirror('dir C:\\ /a'),
      ...mirror('dir C:\\ /o:n'),
      ...mirror('dir C:\\ *.sys'),
      ...mirror('mkdir C:\\CmdCoh',            'create / inspect'),
      ...mirror('md C:\\CmdCoh\\sub'),
      ...mirror('cd C:\\CmdCoh'),
      ...mirror('cd'),
      { shell: 'cmd', cmd: 'echo line-one > C:\\CmdCoh\\file.txt' },
      { shell: 'ps',  cmd: 'echo line-one > C:\\CmdCoh\\file2.txt' },
      ...mirror('type C:\\CmdCoh\\file.txt',   'read content'),
      ...mirror('type C:\\CmdCoh\\file2.txt'),
      ...mirror('more C:\\CmdCoh\\file.txt'),
      ...mirror('copy C:\\CmdCoh\\file.txt C:\\CmdCoh\\copy.txt'),
      ...mirror('move C:\\CmdCoh\\copy.txt C:\\CmdCoh\\moved.txt'),
      ...mirror('ren C:\\CmdCoh\\moved.txt renamed.txt'),
      ...mirror('del C:\\CmdCoh\\renamed.txt'),
      ...mirror('rmdir C:\\CmdCoh\\sub'),

      // ── Section 3: environment & set ────────────────────────────
      ...mirror('set',                         'environment'),
      ...mirror('set PATH'),
      { shell: 'cmd', cmd: 'set MIRROR_KEY=cmd-value' },
      { shell: 'ps',  cmd: 'set MIRROR_KEY=ps-value' },
      ...mirror('echo %MIRROR_KEY%'),
      { shell: 'cmd', cmd: 'set MIRROR_KEY=' },
      { shell: 'ps',  cmd: 'set MIRROR_KEY=' },

      // ── Section 4: process / service natives ────────────────────
      ...mirror('tasklist',                    'processes'),
      ...mirror('tasklist /v'),
      ...mirror('tasklist /fo csv /nh'),
      ...mirror('tasklist /fi "imagename eq svchost.exe"'),
      ...mirror('sc query',                    'services'),
      ...mirror('sc query Spooler'),
      ...mirror('sc qc Spooler'),
      ...mirror('net start'),
      ...mirror('net config workstation'),
      ...mirror('net statistics workstation'),
      ...mirror('net view'),

      // ── Section 5: network natives ──────────────────────────────
      ...mirror('ipconfig',                    'network info'),
      ...mirror('ipconfig /all'),
      ...mirror('ipconfig /displaydns'),
      ...mirror('getmac'),
      ...mirror('getmac /fo csv /nh'),
      ...mirror('arp -a'),
      ...mirror('route print'),
      ...mirror('route print -4'),
      ...mirror('netstat'),
      ...mirror('netstat -a'),
      ...mirror('netstat -n'),
      ...mirror('netstat -ano'),
      ...mirror('nbtstat -n'),
      ...mirror('netsh interface show interface'),
      ...mirror('netsh interface ipv4 show addresses'),
      ...mirror('netsh advfirewall show allprofiles'),
      ...mirror('netsh advfirewall firewall show rule name=all'),
      ...mirror('ping -n 1 127.0.0.1'),
      ...mirror('ping -n 1 localhost'),
      ...mirror('tracert -h 3 127.0.0.1'),
      ...mirror('nslookup localhost'),
      ...mirror('nslookup 127.0.0.1'),
      ...mirror('nslookup example.com'),

      // ── Section 6: registry natives ─────────────────────────────
      ...mirror('reg query HKCU\\Software',    'registry'),
      ...mirror('reg query HKLM\\Software'),
      { shell: 'cmd', cmd: 'reg add HKCU\\Software\\CmdCoh /v K /t REG_SZ /d cmdval /f' },
      { shell: 'ps',  cmd: 'reg add HKCU\\Software\\CmdCoh /v K /t REG_SZ /d psval /f' },
      ...mirror('reg query HKCU\\Software\\CmdCoh'),
      ...mirror('reg query HKCU\\Software\\CmdCoh /v K'),
      ...mirror('reg delete HKCU\\Software\\CmdCoh /f'),

      // ── Section 7: user / group natives ─────────────────────────
      ...mirror('net user',                    'accounts'),
      ...mirror('net user Administrator'),
      ...mirror('net localgroup'),
      ...mirror('net localgroup Administrators'),
      ...mirror('net localgroup Users'),

      // ── Section 8: system info / version ────────────────────────
      ...mirror('systeminfo',                  'system info'),
      ...mirror('wmic logicaldisk get name'),
      ...mirror('wmic os get caption,version'),
      ...mirror('wmic cpu get name'),
      ...mirror('vol C:'),
      ...mirror('chcp'),

      // ── Section 9: help / where / clip ──────────────────────────
      ...mirror('help',                        'help / lookup'),
      ...mirror('help dir'),
      ...mirror('help copy'),
      ...mirror('help reg'),
      ...mirror('where cmd'),
      ...mirror('where notepad'),

      // ── Section 10: PowerShell-only utilities (ps side runs,
      //                cmd side dumps "command not recognised") ───
      { section: 'ps-only utilities',
        shell: 'ps', cmd: 'Get-Command Get-ChildItem' },
      { shell: 'cmd', cmd: 'Get-Command Get-ChildItem' },
      { shell: 'ps',  cmd: 'gcm Get-Service' },
      { shell: 'cmd', cmd: 'gcm Get-Service' },
      { shell: 'ps',  cmd: 'Get-Alias dir' },
      { shell: 'cmd', cmd: 'Get-Alias dir' },
      { shell: 'ps',  cmd: 'Get-Help dir -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: '$PSVersionTable' },
      { shell: 'ps',  cmd: 'Get-PSProvider' },
      { shell: 'ps',  cmd: 'Get-PSDrive' },

      // ── Section 11: cleanup ─────────────────────────────────────
      ...mirror('rmdir /s /q C:\\CmdCoh',      'cleanup'),
      ...mirror('dir C:\\CmdCoh'),
    ];

    expect(commands.length).toBeGreaterThanOrEqual(100);

    const psPc = createPSRunner(pc);
    const cmdPc = createCmdRunner(pc);
    await runCoherenceDump('coherence-cmd-commands-pc', commands, psPc, cmdPc,
      'host=WIN-CMD-COH (windows-pc)');

    const psSrv = createPSRunner(srv);
    const cmdSrv = createCmdRunner(srv);
    await runCoherenceDump('coherence-cmd-commands-server', commands, psSrv, cmdSrv,
      'host=SRV-CMD-COH (windows-server)');
  }, 240_000);
});
