/**
 * Debug run — cmd ↔ PowerShell network coherence.
 *
 * Native CLI tools (`ipconfig`, `netsh`, `arp`, `route`, `getmac`,
 * `netstat`, `hostname`, `nslookup`, `ping`, `tracert`) and the
 * PowerShell `Get-NetAdapter` / `Get-NetIPAddress` / `Test-Connection`
 * / `Resolve-DnsName` family inspect the SAME underlying device
 * state.  This script issues a network change from one side and
 * reads it back from the other (extra IPs via `netsh interface ipv4
 * add address` vs `New-NetIPAddress`, firewall rules via `netsh
 * advfirewall firewall add` vs `New-NetFirewallRule`, etc.).
 *
 * Transcripts →
 *   debug-output/coherence-network-pc_results_debug.txt
 *   debug-output/coherence-network-server_results_debug.txt
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

describe('debug — cmd ↔ PowerShell network coherence', () => {
  it('exercises network ops from both shells', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-NET-COH');
    const srv = new WindowsPC('windows-server', 'SRV-NET-COH');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');

    const commands: CoherenceCommand[] = [
      // ── 1. hostname / identity coherence ────────────────────────
      { section: 'identity', shell: 'cmd', cmd: 'hostname' },
      { shell: 'ps',  cmd: 'hostname' },
      { shell: 'ps',  cmd: '$env:COMPUTERNAME' },
      { shell: 'cmd', cmd: 'echo %COMPUTERNAME%' },
      { shell: 'ps',  cmd: '[Environment]::MachineName' },

      // ── 2. ipconfig coherence ───────────────────────────────────
      { section: 'ipconfig vs Get-NetIPAddress',
        shell: 'cmd', cmd: 'ipconfig' },
      { shell: 'cmd', cmd: 'ipconfig /all' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress | Format-Table InterfaceAlias, IPAddress, AddressFamily, PrefixLength -AutoSize' },
      { shell: 'ps',  cmd: 'Get-NetIPConfiguration -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'ipconfig' },
      { shell: 'ps',  cmd: 'ipconfig /all' },
      { shell: 'cmd', cmd: 'ipconfig /displaydns' },
      { shell: 'ps',  cmd: 'Get-DnsClientCache -ErrorAction SilentlyContinue' },

      // ── 3. Get-NetAdapter coherence ─────────────────────────────
      { section: 'adapters',
        shell: 'cmd', cmd: 'getmac' },
      { shell: 'cmd', cmd: 'getmac /fo csv /nh' },
      { shell: 'ps',  cmd: 'Get-NetAdapter' },
      { shell: 'ps',  cmd: 'Get-NetAdapter | Format-Table Name, Status, MacAddress, LinkSpeed -AutoSize' },
      { shell: 'ps',  cmd: '(Get-NetAdapter).Count' },
      { shell: 'ps',  cmd: 'getmac' },

      // ── 4. netsh interface show vs PS ───────────────────────────
      { section: 'netsh interface',
        shell: 'cmd', cmd: 'netsh interface show interface' },
      { shell: 'ps',  cmd: 'Get-NetAdapter | Select-Object Name, Status, MacAddress' },
      { shell: 'cmd', cmd: 'netsh interface ipv4 show addresses' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'netsh interface ipv4 show config' },

      // ── 5. add IP via cmd → check ps ────────────────────────────
      { section: 'netsh add address (cmd) → ps',
        shell: 'cmd', cmd: 'netsh interface ipv4 add address "Ethernet" 192.168.99.10 255.255.255.0' },
      { shell: 'cmd', cmd: 'ipconfig' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "192.168.99.*" }' },
      { shell: 'cmd', cmd: 'netsh interface ipv4 delete address "Ethernet" 192.168.99.10' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "192.168.99.*" }' },

      // ── 6. add IP via ps → check cmd ────────────────────────────
      { section: 'New-NetIPAddress (ps) → cmd',
        shell: 'ps',  cmd: 'New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.88.10 -PrefixLength 24 -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'ipconfig' },
      { shell: 'cmd', cmd: 'netsh interface ipv4 show addresses' },
      { shell: 'ps',  cmd: 'Remove-NetIPAddress -IPAddress 192.168.88.10 -Confirm:$false -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'ipconfig' },

      // ── 7. routes ───────────────────────────────────────────────
      { section: 'routes',
        shell: 'cmd', cmd: 'route print' },
      { shell: 'cmd', cmd: 'route print -4' },
      { shell: 'ps',  cmd: 'Get-NetRoute -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-NetRoute | Sort-Object DestinationPrefix -ErrorAction SilentlyContinue | Select-Object -First 5' },
      { shell: 'cmd', cmd: 'route add 10.99.0.0 mask 255.255.0.0 192.168.1.254 metric 1' },
      { shell: 'ps',  cmd: 'Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -like "10.99.*" }' },
      { shell: 'cmd', cmd: 'route delete 10.99.0.0' },
      { shell: 'ps',  cmd: 'Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -like "10.99.*" }' },

      // ── 8. ARP table ────────────────────────────────────────────
      { section: 'arp',
        shell: 'cmd', cmd: 'arp -a' },
      { shell: 'ps',  cmd: 'Get-NetNeighbor -ErrorAction SilentlyContinue | Select-Object -First 5' },
      { shell: 'ps',  cmd: 'arp -a' },

      // ── 9. netstat / Get-NetTCPConnection ───────────────────────
      { section: 'netstat',
        shell: 'cmd', cmd: 'netstat' },
      { shell: 'cmd', cmd: 'netstat -a' },
      { shell: 'cmd', cmd: 'netstat -ano' },
      { shell: 'cmd', cmd: 'netstat -n' },
      { shell: 'ps',  cmd: 'Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object -First 5' },
      { shell: 'ps',  cmd: 'netstat' },
      { shell: 'ps',  cmd: 'netstat -a' },

      // ── 10. DNS resolution ──────────────────────────────────────
      { section: 'DNS',
        shell: 'cmd', cmd: 'nslookup localhost' },
      { shell: 'cmd', cmd: 'nslookup 127.0.0.1' },
      { shell: 'cmd', cmd: 'nslookup example.com' },
      { shell: 'ps',  cmd: 'Resolve-DnsName localhost -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Resolve-DnsName 127.0.0.1 -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Resolve-DnsName example.com -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Resolve-DnsName example.com -Type A -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'nslookup example.com' },
      { shell: 'cmd', cmd: 'ipconfig /flushdns' },
      { shell: 'ps',  cmd: 'Clear-DnsClientCache -ErrorAction SilentlyContinue' },

      // ── 11. ping / Test-Connection ──────────────────────────────
      { section: 'ping',
        shell: 'cmd', cmd: 'ping -n 1 127.0.0.1' },
      { shell: 'cmd', cmd: 'ping -n 2 localhost' },
      { shell: 'ps',  cmd: 'Test-Connection 127.0.0.1 -Count 1 -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Test-Connection localhost -Count 1 -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'ping -n 1 127.0.0.1' },
      { shell: 'cmd', cmd: 'ping -n 1 8.8.8.8' },
      { shell: 'ps',  cmd: 'Test-NetConnection 127.0.0.1 -ErrorAction SilentlyContinue' },

      // ── 12. tracert ─────────────────────────────────────────────
      { section: 'tracert',
        shell: 'cmd', cmd: 'tracert -h 5 127.0.0.1' },
      { shell: 'ps',  cmd: 'tracert -h 5 127.0.0.1' },

      // ── 13. firewall coherence ──────────────────────────────────
      { section: 'firewall',
        shell: 'cmd', cmd: 'netsh advfirewall show allprofiles' },
      { shell: 'ps',  cmd: 'Get-NetFirewallProfile -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'netsh advfirewall firewall add rule name="CohFwCmd" dir=in action=allow protocol=TCP localport=9090' },
      { shell: 'ps',  cmd: 'Get-NetFirewallRule -DisplayName "CohFwCmd" -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'netsh advfirewall firewall delete rule name="CohFwCmd"' },
      { shell: 'ps',  cmd: 'New-NetFirewallRule -DisplayName "CohFwPs" -Direction Inbound -Action Allow -LocalPort 9091 -Protocol TCP -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'netsh advfirewall firewall show rule name="CohFwPs"' },
      { shell: 'ps',  cmd: 'Remove-NetFirewallRule -DisplayName "CohFwPs" -ErrorAction SilentlyContinue' },

      // ── 14. DNS servers configuration ───────────────────────────
      { section: 'DNS servers',
        shell: 'cmd', cmd: 'netsh interface ipv4 show dnsservers' },
      { shell: 'ps',  cmd: 'Get-DnsClientServerAddress -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'netsh interface ipv4 set dnsservers "Ethernet" static 8.8.8.8 primary' },
      { shell: 'ps',  cmd: 'Get-DnsClientServerAddress -ErrorAction SilentlyContinue' },

      // ── 15. utility / discovery ─────────────────────────────────
      { section: 'discovery',
        shell: 'ps',  cmd: 'Get-Command -Noun NetAdapter -ErrorAction SilentlyContinue | Select-Object Name' },
      { shell: 'ps',  cmd: 'Get-Command -Noun NetIPAddress -ErrorAction SilentlyContinue | Select-Object Name' },
      { shell: 'ps',  cmd: 'gcm Test-Connection' },
      { shell: 'ps',  cmd: 'gcm Resolve-DnsName' },
      { shell: 'ps',  cmd: 'Get-Alias ipconfig -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-Alias ping -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-Help Get-NetAdapter -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'help ipconfig' },
      { shell: 'cmd', cmd: 'help netsh' },
      { shell: 'cmd', cmd: 'help route' },

      // ── 16. summary ─────────────────────────────────────────────
      { section: 'summary',
        shell: 'cmd', cmd: 'ipconfig | findstr IPv4' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress | Where-Object { $_.AddressFamily -eq "IPv4" } | Select-Object IPAddress, InterfaceAlias' },
      { shell: 'cmd', cmd: 'netstat -an | find /c ":"' },
      { shell: 'ps',  cmd: '(Get-NetTCPConnection -ErrorAction SilentlyContinue).Count' },
      { shell: 'ps',  cmd: 'Get-NetAdapter | Group-Object Status | Format-Table Name, Count -AutoSize' },
      { shell: 'ps',  cmd: 'Get-NetIPAddress | Group-Object AddressFamily | Format-Table Name, Count -AutoSize' },
      { shell: 'cmd', cmd: 'getmac | findstr -i :' },
      { shell: 'ps',  cmd: 'Get-NetAdapter | ForEach-Object { "$($_.Name) -> $($_.Status)" }' },
    ];

    expect(commands.length).toBeGreaterThanOrEqual(100);

    const psPc = createPSRunner(pc);
    const cmdPc = createCmdRunner(pc);
    await runCoherenceDump('coherence-network-pc', commands, psPc, cmdPc,
      'host=WIN-NET-COH (windows-pc)');

    const psSrv = createPSRunner(srv);
    const cmdSrv = createCmdRunner(srv);
    await runCoherenceDump('coherence-network-server', commands, psSrv, cmdSrv,
      'host=SRV-NET-COH (windows-server)');
  }, 240_000);
});
