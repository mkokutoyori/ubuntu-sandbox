/**
 * Stand-alone PowerShell constants — extracted so tab-completion and the
 * subshell banner can stay independent of PowerShellExecutor (which is on
 * the Phase 4 chopping block).
 */

export const PS_BANNER = `Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.

Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows
`;

/**
 * Tab-completion list for the PowerShell sub-shell. Static rather than
 * generated from the cmdlet registry so it stays predictable across
 * Phase 4 churn and presents the most useful subset rather than every
 * registered cmdlet.
 */
export const PS_CMDLETS_LIST = [
  'Get-ChildItem', 'Set-Location', 'Get-Location', 'Get-Content', 'Set-Content',
  'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item',
  'Write-Host', 'Write-Output', 'Clear-Host', 'Get-Process', 'Get-Help',
  'Get-Command', 'Get-NetIPConfiguration', 'Get-NetIPAddress', 'Get-NetAdapter',
  'Test-Connection', 'Get-Date', 'Get-History', 'Get-ExecutionPolicy',
  'Set-ExecutionPolicy', 'Get-Service', 'Get-CimInstance', 'Resolve-DnsName',
  'Select-String', 'Measure-Object', 'Sort-Object', 'Select-Object',
  'Format-Table', 'Format-List', 'Where-Object', 'ForEach-Object',
  // User/Group/ACL management
  'Get-LocalUser', 'New-LocalUser', 'Set-LocalUser', 'Remove-LocalUser',
  'Enable-LocalUser', 'Disable-LocalUser',
  'Get-LocalGroup', 'New-LocalGroup', 'Remove-LocalGroup',
  'Add-LocalGroupMember', 'Remove-LocalGroupMember', 'Get-LocalGroupMember',
  'Get-Acl',
  // Service/Process management
  'Start-Service', 'Stop-Service', 'Restart-Service', 'Set-Service',
  'Suspend-Service', 'Resume-Service', 'New-Service', 'Remove-Service',
  'Stop-Process',
  // Aliases
  'ls', 'dir', 'cd', 'pwd', 'cat', 'type', 'echo', 'cls', 'clear',
  'cp', 'mv', 'rm', 'del', 'ren', 'mkdir', 'rmdir',
  'ipconfig', 'ping', 'netsh', 'tracert', 'arp', 'route',
  'hostname', 'systeminfo', 'ver', 'exit', 'cmd',
];
