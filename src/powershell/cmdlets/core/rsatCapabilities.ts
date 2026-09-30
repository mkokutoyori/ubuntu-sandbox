import type { CmdletRegistry } from '@/powershell/runtime/PSCmdletRegistry';
import { registerDnsServerCmdlets, registerDhcpServerCmdlets, registerGroupPolicyCmdlets } from './index';

export interface RsatCapability {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly register: (registry: CmdletRegistry) => void;
}

export const RSAT_CAPABILITIES: readonly RsatCapability[] = [
  {
    name: 'Rsat.DHCP.Tools~~~~0.0.1.0', displayName: 'RSAT: DHCP Server Tools',
    description: 'DHCP Server Tools include the DHCP MMC snap-in, DHCP server netsh context and Windows PowerShell module for DHCP Server.',
    register: registerDhcpServerCmdlets,
  },
  {
    name: 'Rsat.Dns.Tools~~~~0.0.1.0', displayName: 'RSAT: DNS Server Tools',
    description: 'DNS Server Tools include the DNS Manager snap-in, dnscmd.exe command-line tool, and Windows PowerShell module for DNS Server.',
    register: registerDnsServerCmdlets,
  },
  {
    name: 'Rsat.GroupPolicy.Management.Tools~~~~0.0.1.0', displayName: 'RSAT: Group Policy Management Tools',
    description: 'Group Policy Management Tools include the Group Policy Management Console, Group Policy Management Editor, Group Policy Starter GPO Editor, and Windows PowerShell module for Group Policy.',
    register: registerGroupPolicyCmdlets,
  },
];
