/**
 * Windows CMD System Commands
 * ver, systeminfo, hostname, set, date, time, tasklist, etc.
 */

import { WindowsCommandResult, WindowsTerminalState, WindowsProcess } from '../types';
import { WindowsFileSystem } from '../filesystem';
import { CmdCommandRegistry } from './index';

// Simulated process list
function getProcessList(): WindowsProcess[] {
  return [
    { pid: 0, name: 'System Idle Process', sessionName: 'Services', sessionId: 0, memUsage: 8, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:00' },
    { pid: 4, name: 'System', sessionName: 'Services', sessionId: 0, memUsage: 144, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:01' },
    { pid: 88, name: 'Registry', sessionName: 'Services', sessionId: 0, memUsage: 23552, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:00' },
    { pid: 372, name: 'smss.exe', sessionName: 'Services', sessionId: 0, memUsage: 1024, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:00' },
    { pid: 476, name: 'csrss.exe', sessionName: 'Services', sessionId: 0, memUsage: 4096, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:02' },
    { pid: 552, name: 'wininit.exe', sessionName: 'Services', sessionId: 0, memUsage: 5632, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:00' },
    { pid: 560, name: 'csrss.exe', sessionName: 'Console', sessionId: 1, memUsage: 4608, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:01' },
    { pid: 656, name: 'winlogon.exe', sessionName: 'Console', sessionId: 1, memUsage: 6656, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:00' },
    { pid: 680, name: 'services.exe', sessionName: 'Services', sessionId: 0, memUsage: 8704, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:01' },
    { pid: 688, name: 'lsass.exe', sessionName: 'Services', sessionId: 0, memUsage: 13312, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:00' },
    { pid: 792, name: 'svchost.exe', sessionName: 'Services', sessionId: 0, memUsage: 17408, status: 'Running', user: 'SYSTEM', cpuTime: '0:00:01' },
    { pid: 856, name: 'svchost.exe', sessionName: 'Services', sessionId: 0, memUsage: 9216, status: 'Running', user: 'LOCAL SERVICE', cpuTime: '0:00:00' },
    { pid: 948, name: 'svchost.exe', sessionName: 'Services', sessionId: 0, memUsage: 22016, status: 'Running', user: 'NETWORK SERVICE', cpuTime: '0:00:02' },
    { pid: 1056, name: 'dwm.exe', sessionName: 'Console', sessionId: 1, memUsage: 65536, status: 'Running', user: 'DWM-1', cpuTime: '0:00:05' },
    { pid: 1256, name: 'explorer.exe', sessionName: 'Console', sessionId: 1, memUsage: 98304, status: 'Running', user: 'User', cpuTime: '0:00:10', windowTitle: 'Windows Explorer' },
    { pid: 2048, name: 'cmd.exe', sessionName: 'Console', sessionId: 1, memUsage: 4096, status: 'Running', user: 'User', cpuTime: '0:00:00', windowTitle: 'Command Prompt' },
  ];
}

export const systemCommands: CmdCommandRegistry = {
  // VER - Display Windows Version
  ver: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return {
      output: '\r\nMicrosoft Windows [Version 10.0.22621.2428]\r\n',
      exitCode: 0,
    };
  },

  // SYSTEMINFO - Display System Information
  systeminfo: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const now = new Date();
    const bootTime = new Date(now.getTime() - 86400000); // 1 day ago

    const output = `
Host Name:                 ${state.hostname.toUpperCase()}
OS Name:                   Microsoft Windows 10 Pro
OS Version:                10.0.22621 N/A Build 22621
OS Manufacturer:           Microsoft Corporation
OS Configuration:          Standalone Workstation
OS Build Type:             Multiprocessor Free
Registered Owner:          ${state.currentUser}
Registered Organization:   N/A
Product ID:                00330-80000-00000-AA123
Original Install Date:     1/1/2024, 12:00:00 AM
System Boot Time:          ${bootTime.toLocaleDateString()}, ${bootTime.toLocaleTimeString()}
System Manufacturer:       Virtual Machine
System Model:              NetSim Virtual PC
System Type:               x64-based PC
Processor(s):              1 Processor(s) Installed.
                           [01]: Intel64 Family 6 Model 142 Stepping 11 GenuineIntel ~1800 Mhz
BIOS Version:              Virtual BIOS v1.0, 1/1/2024
Windows Directory:         C:\\Windows
System Directory:          C:\\Windows\\system32
Boot Device:               \\Device\\HarddiskVolume1
System Locale:             en-us;English (United States)
Input Locale:              en-us;English (United States)
Time Zone:                 (UTC) Coordinated Universal Time
Total Physical Memory:     16,384 MB
Available Physical Memory: 8,192 MB
Virtual Memory: Max Size:  32,768 MB
Virtual Memory: Available: 24,576 MB
Virtual Memory: In Use:    8,192 MB
Page File Location(s):     C:\\pagefile.sys
Domain:                    WORKGROUP
Logon Server:              \\\\${state.hostname.toUpperCase()}
Hotfix(s):                 3 Hotfix(s) Installed.
                           [01]: KB5031356
                           [02]: KB5031455
                           [03]: KB5032189
Network Card(s):           1 NIC(s) Installed.
                           [01]: Intel(R) Ethernet Controller
                                 Connection Name: Ethernet
                                 DHCP Enabled:    Yes
                                 DHCP Server:     192.168.1.1
                                 IP address(es)
                                 [01]: 192.168.1.100
                                 [02]: fe80::1234:5678:abcd:ef01
Hyper-V Requirements:      A hypervisor has been detected. Features required for Hyper-V will not be displayed.
`;
    return { output: output.trim(), exitCode: 0 };
  },

  // HOSTNAME - Display Computer Name
  hostname: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return { output: state.hostname.toUpperCase(), exitCode: 0 };
  },

  // SET - Display/Set Environment Variables
  set: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      // Display all environment variables
      const vars = Object.entries(state.env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\r\n');
      return { output: vars, exitCode: 0 };
    }

    // Check if it's a query (e.g., SET PATH)
    if (!args[0].includes('=')) {
      const prefix = args[0].toUpperCase();
      const matches = Object.entries(state.env)
        .filter(([key]) => key.toUpperCase().startsWith(prefix))
        .map(([key, value]) => `${key}=${value}`)
        .join('\r\n');

      if (!matches) {
        return { output: '', error: 'Environment variable ' + args[0] + ' not defined', exitCode: 1 };
      }
      return { output: matches, exitCode: 0 };
    }

    // Set variable (handled in index.ts)
    return { output: '', exitCode: 0 };
  },

  // DATE - Display/Set Date
  date: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.some(a => a.toLowerCase() === '/t')) {
      return { output: new Date().toLocaleDateString(), exitCode: 0 };
    }
    const now = new Date();
    return { output: `The current date is: ${now.toLocaleDateString()}\r\nEnter the new date: (mm-dd-yy)`, exitCode: 0 };
  },

  // TIME - Display/Set Time
  time: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.some(a => a.toLowerCase() === '/t')) {
      return { output: new Date().toLocaleTimeString(), exitCode: 0 };
    }
    const now = new Date();
    return { output: `The current time is: ${now.toLocaleTimeString()}\r\nEnter the new time:`, exitCode: 0 };
  },

  // TASKLIST - List Running Processes
  tasklist: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const verbose = args.some(a => a.toLowerCase() === '/v');
    const processes = getProcessList();

    let output = '';

    if (verbose) {
      output = `\r\nImage Name                     PID Session Name        Session#    Mem Usage Status          User Name                                              CPU Time Window Title\r\n`;
      output += `========================= ======== ================ =========== ============ =============== ================================================== ============ ========================================================================\r\n`;

      for (const proc of processes) {
        output += `${proc.name.padEnd(26)}${String(proc.pid).padStart(8)} ${proc.sessionName.padEnd(17)}${String(proc.sessionId).padStart(11)} ${(proc.memUsage + ' K').padStart(12)} ${proc.status.padEnd(16)}${proc.user.padEnd(50)} ${proc.cpuTime.padStart(12)} ${proc.windowTitle || 'N/A'}\r\n`;
      }
    } else {
      output = `\r\nImage Name                     PID Session Name        Session#    Mem Usage\r\n`;
      output += `========================= ======== ================ =========== ============\r\n`;

      for (const proc of processes) {
        output += `${proc.name.padEnd(26)}${String(proc.pid).padStart(8)} ${proc.sessionName.padEnd(17)}${String(proc.sessionId).padStart(11)} ${(proc.memUsage + ' K').padStart(12)}\r\n`;
      }
    }

    return { output, exitCode: 0 };
  },

  // TASKKILL - Terminate Process
  taskkill: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const forceful = args.some(a => a.toLowerCase() === '/f');
    const pidIndex = args.findIndex(a => a.toLowerCase() === '/pid');
    const nameIndex = args.findIndex(a => a.toLowerCase() === '/im');

    if (pidIndex !== -1 && args[pidIndex + 1]) {
      const pid = parseInt(args[pidIndex + 1]);
      const processes = getProcessList();
      const proc = processes.find(p => p.pid === pid);

      if (!proc) {
        return { output: '', error: `ERROR: The process "${pid}" not found.`, exitCode: 1 };
      }

      if (proc.user === 'SYSTEM' && !state.isAdmin) {
        return { output: '', error: 'ERROR: Access is denied.', exitCode: 1 };
      }

      return { output: `SUCCESS: ${forceful ? 'The process with PID ' + pid + ' has been terminated.' : 'Sent termination signal to the process with PID ' + pid + '.'}`, exitCode: 0 };
    }

    if (nameIndex !== -1 && args[nameIndex + 1]) {
      const name = args[nameIndex + 1];
      return { output: `SUCCESS: ${forceful ? 'The process "' + name + '" has been terminated.' : 'Sent termination signal to process "' + name + '".'}`, exitCode: 0 };
    }

    return { output: '', error: 'ERROR: Invalid syntax. Type "TASKKILL /?" for usage.', exitCode: 1 };
  },

  // WHOAMI - Display Current User
  whoami: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const showAll = args.some(a => a.toLowerCase() === '/all');
    const showUser = args.some(a => a.toLowerCase() === '/user');
    const showGroups = args.some(a => a.toLowerCase() === '/groups');

    const user = fs.getUser(state.currentUser);
    const domain = state.hostname.toUpperCase();

    if (showAll) {
      let output = `\r\nUSER INFORMATION\r\n----------------\r\n\r\n`;
      output += `User Name     SID\r\n`;
      output += `============= =============================================\r\n`;
      output += `${domain}\\${state.currentUser}   ${user?.sid || 'S-1-5-21-0-0-0-1001'}\r\n\r\n`;

      output += `GROUP INFORMATION\r\n-----------------\r\n\r\n`;
      output += `Group Name                             Type             SID          Attributes\r\n`;
      output += `====================================== ================ ============ ==================================================\r\n`;
      output += `Everyone                               Well-known group S-1-1-0      Mandatory group, Enabled by default, Enabled group\r\n`;
      output += `BUILTIN\\Users                          Alias            S-1-5-32-545 Mandatory group, Enabled by default, Enabled group\r\n`;

      if (state.isAdmin) {
        output += `BUILTIN\\Administrators                 Alias            S-1-5-32-544 Mandatory group, Enabled by default, Enabled group, Group owner\r\n`;
      }

      return { output, exitCode: 0 };
    }

    if (showUser) {
      let output = `\r\nUSER INFORMATION\r\n----------------\r\n\r\n`;
      output += `User Name     SID\r\n`;
      output += `============= =============================================\r\n`;
      output += `${domain}\\${state.currentUser}   ${user?.sid || 'S-1-5-21-0-0-0-1001'}\r\n`;
      return { output, exitCode: 0 };
    }

    if (showGroups) {
      let output = `\r\nGROUP INFORMATION\r\n-----------------\r\n\r\n`;
      output += `Group Name                             Type             SID\r\n`;
      output += `====================================== ================ ============\r\n`;
      output += `Everyone                               Well-known group S-1-1-0\r\n`;
      output += `BUILTIN\\Users                          Alias            S-1-5-32-545\r\n`;
      return { output, exitCode: 0 };
    }

    return { output: `${domain}\\${state.currentUser}`.toLowerCase(), exitCode: 0 };
  },

  // SHUTDOWN - Shutdown/Restart Computer
  shutdown: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const showHelp = args.some(a => a.toLowerCase() === '/?');

    if (showHelp) {
      return {
        output: `Usage: shutdown [/i | /l | /s | /sg | /r | /g | /a | /p | /h | /e | /o] [/hybrid] [/soft] [/fw] [/f]
    [/m \\\\computer][/t xxx][/d [p|u:]xx:yy [/c "comment"]]

    No args    Display help. This is the same as typing /?.
    /?         Display help. This is the same as not typing any options.
    /s         Shutdown the computer.
    /r         Full shutdown and restart the computer.
    /l         Log off. Cannot be used with /m or /d options.
    /a         Abort a system shutdown.
    /t xxx     Set the time-out period before shutdown to xxx seconds.`,
        exitCode: 0,
      };
    }

    const restart = args.some(a => a.toLowerCase() === '/r');
    const logoff = args.some(a => a.toLowerCase() === '/l');
    const abort = args.some(a => a.toLowerCase() === '/a');

    if (abort) {
      return { output: 'Shutdown aborted.', exitCode: 0 };
    }

    if (logoff) {
      return { output: 'Logging off...', exitCode: 0 };
    }

    if (restart) {
      return { output: 'Restarting computer...', exitCode: 0 };
    }

    return { output: 'Shutting down...', exitCode: 0 };
  },

  // PATH - Display/Set PATH Variable
  path: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: `PATH=${state.env.PATH || state.env.Path || ''}`, exitCode: 0 };
    }

    // Setting path handled elsewhere
    return { output: '', exitCode: 0 };
  },

  // TITLE - Set Window Title
  title: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    // In a real terminal this would change the window title
    // Here we just acknowledge it
    return { output: '', exitCode: 0 };
  },

  // PROMPT - Change Command Prompt
  prompt: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    // In a real terminal this would change the prompt format
    return { output: '', exitCode: 0 };
  },
};
