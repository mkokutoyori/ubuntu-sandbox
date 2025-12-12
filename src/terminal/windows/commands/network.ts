/**
 * Windows CMD Network Commands
 * ipconfig, ping, netstat, tracert, nslookup, arp, route, net, etc.
 */

import { WindowsCommandResult, WindowsTerminalState } from '../types';
import { WindowsFileSystem } from '../filesystem';
import { CmdCommandRegistry } from './index';

export const networkCommands: CmdCommandRegistry = {
  // IPCONFIG - Display IP Configuration
  ipconfig: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const showAll = args.some(a => a.toLowerCase() === '/all');
    const release = args.some(a => a.toLowerCase() === '/release');
    const renew = args.some(a => a.toLowerCase() === '/renew');
    const flushdns = args.some(a => a.toLowerCase() === '/flushdns');
    const displaydns = args.some(a => a.toLowerCase() === '/displaydns');

    if (flushdns) {
      return { output: '\r\nWindows IP Configuration\r\n\r\nSuccessfully flushed the DNS Resolver Cache.', exitCode: 0 };
    }

    if (release) {
      return { output: '\r\nWindows IP Configuration\r\n\r\nNo operation can be performed on Ethernet while it has its media disconnected.', exitCode: 0 };
    }

    if (renew) {
      return { output: '\r\nWindows IP Configuration\r\n\r\nNo operation can be performed on Ethernet while it has its media disconnected.', exitCode: 0 };
    }

    if (displaydns) {
      return {
        output: `
Windows IP Configuration

    localhost
    ----------------------------------------
    Record Name . . . . . : localhost
    Record Type . . . . . : 1
    Time To Live  . . . . : 604765
    Data Length . . . . . : 4
    Section . . . . . . . : Answer
    A (Host) Record . . . : 127.0.0.1
`,
        exitCode: 0,
      };
    }

    let output = '\r\nWindows IP Configuration\r\n';

    if (showAll) {
      output += `
   Host Name . . . . . . . . . . . . : ${state.hostname}
   Primary Dns Suffix  . . . . . . . :
   Node Type . . . . . . . . . . . . : Hybrid
   IP Routing Enabled. . . . . . . . : No
   WINS Proxy Enabled. . . . . . . . : No
   DNS Suffix Search List. . . . . . : localdomain

Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . : localdomain
   Description . . . . . . . . . . . : Intel(R) Ethernet Controller
   Physical Address. . . . . . . . . : 00-15-5D-AB-CD-EF
   DHCP Enabled. . . . . . . . . . . : Yes
   Autoconfiguration Enabled . . . . : Yes
   IPv4 Address. . . . . . . . . . . : 192.168.1.100(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Lease Obtained. . . . . . . . . . : ${new Date().toLocaleDateString()}
   Lease Expires . . . . . . . . . . : ${new Date(Date.now() + 86400000).toLocaleDateString()}
   Default Gateway . . . . . . . . . : 192.168.1.1
   DHCP Server . . . . . . . . . . . : 192.168.1.1
   DNS Servers . . . . . . . . . . . : 8.8.8.8
                                       8.8.4.4
   NetBIOS over Tcpip. . . . . . . . : Enabled
`;
    } else {
      output += `
Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . : localdomain
   IPv4 Address. . . . . . . . . . . : 192.168.1.100
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1
`;
    }

    return { output, exitCode: 0 };
  },

  // PING - Test Network Connectivity
  ping: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: `\r\nUsage: ping [-t] [-a] [-n count] [-l size] [-f] [-i TTL] [-v TOS]\r\n            [-r count] [-s count] [[-j host-list] | [-k host-list]]\r\n            [-w timeout] [-R] [-S srcaddr] [-c compartment] [-p]\r\n            [-4] [-6] target_name`, exitCode: 1 };
    }

    let count = 4;
    let target = '';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i].toLowerCase();
      if (arg === '-n' && args[i + 1]) {
        count = parseInt(args[i + 1]) || 4;
        i++;
      } else if (arg === '-t') {
        count = 4; // Continuous ping - we'll just do 4
      } else if (!args[i].startsWith('-')) {
        target = args[i];
      }
    }

    if (!target) {
      return { output: '', error: 'IP address must be specified.', exitCode: 1 };
    }

    // Resolve hostname to IP (simulated)
    const ip = target.match(/^\d+\.\d+\.\d+\.\d+$/) ? target : '93.184.216.34';
    const resolvedName = target.match(/^\d+\.\d+\.\d+\.\d+$/) ? '' : ` [${ip}]`;

    let output = `\r\nPinging ${target}${resolvedName} with 32 bytes of data:\r\n`;

    let received = 0;
    let minTime = 999;
    let maxTime = 0;
    let totalTime = 0;

    for (let i = 0; i < count; i++) {
      const time = Math.floor(Math.random() * 50) + 10;
      minTime = Math.min(minTime, time);
      maxTime = Math.max(maxTime, time);
      totalTime += time;
      received++;
      output += `Reply from ${ip}: bytes=32 time=${time}ms TTL=64\r\n`;
    }

    const avgTime = Math.floor(totalTime / count);
    const lost = count - received;
    const lostPercent = Math.floor((lost / count) * 100);

    output += `\r\nPing statistics for ${ip}:\r\n`;
    output += `    Packets: Sent = ${count}, Received = ${received}, Lost = ${lost} (${lostPercent}% loss),\r\n`;
    output += `Approximate round trip times in milli-seconds:\r\n`;
    output += `    Minimum = ${minTime}ms, Maximum = ${maxTime}ms, Average = ${avgTime}ms`;

    return { output, exitCode: 0 };
  },

  // NETSTAT - Network Statistics
  netstat: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const showAll = args.some(a => a.toLowerCase() === '-a');
    const numeric = args.some(a => a.toLowerCase() === '-n');
    const showPid = args.some(a => a.toLowerCase() === '-o');
    const showProto = args.some(a => a.toLowerCase() === '-p');

    let output = '\r\nActive Connections\r\n\r\n';

    if (showPid) {
      output += '  Proto  Local Address          Foreign Address        State           PID\r\n';
      output += '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888\r\n';
      output += '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4\r\n';
      output += '  TCP    0.0.0.0:5040           0.0.0.0:0              LISTENING       6820\r\n';
      output += '  TCP    192.168.1.100:139      0.0.0.0:0              LISTENING       4\r\n';
      output += '  TCP    192.168.1.100:49667    40.90.189.152:443      ESTABLISHED     2048\r\n';
      output += '  UDP    0.0.0.0:123            *:*                                    1184\r\n';
      output += '  UDP    0.0.0.0:5353           *:*                                    1672\r\n';
      output += '  UDP    0.0.0.0:5355           *:*                                    1672\r\n';
    } else {
      output += '  Proto  Local Address          Foreign Address        State\r\n';
      output += '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING\r\n';
      output += '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING\r\n';
      output += '  TCP    192.168.1.100:139      0.0.0.0:0              LISTENING\r\n';
      output += '  TCP    192.168.1.100:49667    40.90.189.152:443      ESTABLISHED\r\n';
      output += '  UDP    0.0.0.0:123            *:*\r\n';
      output += '  UDP    0.0.0.0:5353           *:*\r\n';
    }

    return { output, exitCode: 0 };
  },

  // TRACERT - Trace Route
  tracert: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: '\r\nUsage: tracert [-d] [-h maximum_hops] [-j host-list] [-w timeout]\r\n               [-R] [-S srcaddr] [-4] [-6] target_name', exitCode: 1 };
    }

    const target = args.find(a => !a.startsWith('-')) || 'localhost';
    const ip = target.match(/^\d+\.\d+\.\d+\.\d+$/) ? target : '93.184.216.34';

    let output = `\r\nTracing route to ${target} [${ip}]\r\nover a maximum of 30 hops:\r\n\r\n`;

    const hops = [
      { ip: '192.168.1.1', times: [1, 1, 1] },
      { ip: '10.0.0.1', times: [8, 7, 9] },
      { ip: '172.16.0.1', times: [15, 14, 16] },
      { ip: '8.8.8.8', times: [20, 22, 21] },
      { ip: ip, times: [25, 24, 26] },
    ];

    hops.forEach((hop, index) => {
      const times = hop.times.map(t => `${t} ms`.padStart(8));
      output += `  ${index + 1}    ${times[0]}${times[1]}${times[2]}  ${hop.ip}\r\n`;
    });

    output += '\r\nTrace complete.';

    return { output, exitCode: 0 };
  },

  // NSLOOKUP - DNS Lookup
  nslookup: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return {
        output: `Default Server:  dns.google\r\nAddress:  8.8.8.8\r\n\r\n> `,
        exitCode: 0,
      };
    }

    const target = args[0];
    const ip = target.match(/^\d+\.\d+\.\d+\.\d+$/) ? target : '93.184.216.34';

    let output = `Server:  dns.google\r\nAddress:  8.8.8.8\r\n\r\n`;
    output += `Non-authoritative answer:\r\n`;
    output += `Name:    ${target}\r\n`;
    output += `Address:  ${ip}`;

    return { output, exitCode: 0 };
  },

  // ARP - Display/Modify ARP Cache
  arp: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const showAll = args.some(a => a.toLowerCase() === '-a');
    const showHelp = args.some(a => a.toLowerCase() === '/?');

    if (showHelp) {
      return {
        output: `\r\nDisplays and modifies the IP-to-Physical address translation tables used by\r\naddress resolution protocol (ARP).\r\n\r\nARP -s inet_addr eth_addr [if_addr]\r\nARP -d inet_addr [if_addr]\r\nARP -a [inet_addr] [-N if_addr] [-v]`,
        exitCode: 0,
      };
    }

    if (showAll || args.length === 0) {
      let output = `\r\nInterface: 192.168.1.100 --- 0xb\r\n`;
      output += `  Internet Address      Physical Address      Type\r\n`;
      output += `  192.168.1.1           00-11-22-33-44-55     dynamic\r\n`;
      output += `  192.168.1.255         ff-ff-ff-ff-ff-ff     static\r\n`;
      output += `  224.0.0.22            01-00-5e-00-00-16     static\r\n`;
      output += `  224.0.0.251           01-00-5e-00-00-fb     static\r\n`;
      output += `  224.0.0.252           01-00-5e-00-00-fc     static\r\n`;
      output += `  255.255.255.255       ff-ff-ff-ff-ff-ff     static`;
      return { output, exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  },

  // ROUTE - Display/Modify Routing Table
  route: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const print = args.some(a => a.toLowerCase() === 'print');

    if (print || args.length === 0) {
      let output = `\r\n===========================================================================\r\n`;
      output += `Interface List\r\n`;
      output += ` 11...00 15 5d ab cd ef ......Intel(R) Ethernet Controller\r\n`;
      output += `  1...........................Software Loopback Interface 1\r\n`;
      output += `===========================================================================\r\n\r\n`;
      output += `IPv4 Route Table\r\n`;
      output += `===========================================================================\r\n`;
      output += `Active Routes:\r\n`;
      output += `Network Destination        Netmask          Gateway       Interface  Metric\r\n`;
      output += `          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.100     25\r\n`;
      output += `        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331\r\n`;
      output += `        127.0.0.1  255.255.255.255         On-link         127.0.0.1    331\r\n`;
      output += `  127.255.255.255  255.255.255.255         On-link         127.0.0.1    331\r\n`;
      output += `      192.168.1.0    255.255.255.0         On-link     192.168.1.100    281\r\n`;
      output += `    192.168.1.100  255.255.255.255         On-link     192.168.1.100    281\r\n`;
      output += `    192.168.1.255  255.255.255.255         On-link     192.168.1.100    281\r\n`;
      output += `        224.0.0.0        240.0.0.0         On-link         127.0.0.1    331\r\n`;
      output += `        224.0.0.0        240.0.0.0         On-link     192.168.1.100    281\r\n`;
      output += `  255.255.255.255  255.255.255.255         On-link         127.0.0.1    331\r\n`;
      output += `  255.255.255.255  255.255.255.255         On-link     192.168.1.100    281\r\n`;
      output += `===========================================================================\r\n`;
      output += `Persistent Routes:\r\n`;
      output += `  None`;
      return { output, exitCode: 0 };
    }

    return { output: '', error: 'The requested operation requires elevation.', exitCode: 1 };
  },

  // NET - Network Commands
  net: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return {
        output: `\r\nThe syntax of this command is:\r\n\r\nNET\r\n    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\r\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\r\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]`,
        exitCode: 0,
      };
    }

    const subCommand = args[0].toLowerCase();

    switch (subCommand) {
      case 'user':
        if (args.length === 1) {
          return {
            output: `\r\nUser accounts for \\\\${state.hostname.toUpperCase()}\r\n\r\n-------------------------------------------------------------------------------\r\nAdministrator            DefaultAccount           Guest\r\nUser                     WDAGUtilityAccount\r\nThe command completed successfully.`,
            exitCode: 0,
          };
        }
        break;

      case 'localgroup':
        return {
          output: `\r\nAliases for \\\\${state.hostname.toUpperCase()}\r\n\r\n-------------------------------------------------------------------------------\r\n*Access Control Assistance Operators\r\n*Administrators\r\n*Backup Operators\r\n*Cryptographic Operators\r\n*Device Owners\r\n*Distributed COM Users\r\n*Event Log Readers\r\n*Guests\r\n*Hyper-V Administrators\r\n*IIS_IUSRS\r\n*Network Configuration Operators\r\n*Performance Log Users\r\n*Performance Monitor Users\r\n*Power Users\r\n*Remote Desktop Users\r\n*Remote Management Users\r\n*Replicator\r\n*System Managed Accounts Group\r\n*Users\r\nThe command completed successfully.`,
          exitCode: 0,
        };

      case 'share':
        return {
          output: `\r\nShare name   Resource                        Remark\r\n\r\n-------------------------------------------------------------------------------\r\nC$           C:\\                             Default share\r\nIPC$                                         Remote IPC\r\nADMIN$       C:\\Windows                      Remote Admin\r\nThe command completed successfully.`,
          exitCode: 0,
        };

      case 'start':
        return {
          output: `\r\nThese Windows services are started:\r\n\r\n   Background Tasks Infrastructure Service\r\n   Base Filtering Engine\r\n   COM+ Event System\r\n   Cryptographic Services\r\n   DCOM Server Process Launcher\r\n   DHCP Client\r\n   DNS Client\r\n   Windows Defender Firewall\r\n   Windows Event Log\r\nThe command completed successfully.`,
          exitCode: 0,
        };

      case 'view':
        return {
          output: `\r\nServer Name            Remark\r\n\r\n-------------------------------------------------------------------------------\r\n\\\\${state.hostname.toUpperCase()}\r\nThe command completed successfully.`,
          exitCode: 0,
        };
    }

    return { output: '', error: 'The syntax of this command is incorrect.', exitCode: 1 };
  },

  // GETMAC - Get MAC Address
  getmac: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    let output = `\r\nPhysical Address    Transport Name\r\n`;
    output += `=================== ==========================================================\r\n`;
    output += `00-15-5D-AB-CD-EF   \\Device\\Tcpip_{12345678-1234-1234-1234-123456789ABC}`;
    return { output, exitCode: 0 };
  },

  // PATHPING - Trace route + ping
  pathping: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: pathping [-g host-list] [-h maximum_hops] [-i address] [-n]\r\n                [-p period] [-q num_queries] [-w timeout]\r\n                [-4] [-6] target_name', exitCode: 1 };
    }

    const target = args.find(a => !a.startsWith('-')) || 'localhost';

    return {
      output: `\r\nTracing route to ${target} [93.184.216.34]\r\nover a maximum of 30 hops:\r\n  0  ${state.hostname} [192.168.1.100]\r\n  1  192.168.1.1\r\n  2  10.0.0.1\r\n  3  93.184.216.34\r\n\r\nComputing statistics for 75 seconds...\r\n            Source to Here   This Node/Link\r\nHop  RTT    Lost/Sent = Pct  Lost/Sent = Pct  Address\r\n  0                                           ${state.hostname} [192.168.1.100]\r\n                                0/ 100 =  0%   |\r\n  1    1ms     0/ 100 =  0%     0/ 100 =  0%  192.168.1.1\r\n                                0/ 100 =  0%   |\r\n  2   10ms     0/ 100 =  0%     0/ 100 =  0%  10.0.0.1\r\n                                0/ 100 =  0%   |\r\n  3   25ms     0/ 100 =  0%     0/ 100 =  0%  93.184.216.34\r\n\r\nTrace complete.`,
      exitCode: 0,
    };
  },
};
