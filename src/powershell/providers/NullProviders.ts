/**
 * NullProviders — All-null PSProviders implementation.
 *
 * Used by PSInterpreter (pure language mode, no Windows device attached).
 * Core cmdlets (Write-Host, ForEach-Object, etc.) work fine without providers.
 * Windows-specific cmdlets (Get-Service, Get-NetIPAddress, etc.) check for null
 * before accessing providers, and return a graceful error message.
 */

import type { PSProviders } from './PSProviders';
import { SimulatedFileSystem } from './SimulatedFileSystem';
import { JobProvider } from './JobProvider';

export const NULL_PROVIDERS: PSProviders = {
  filesystem:     new SimulatedFileSystem(),
  registry:       null,
  services:       null,
  network:        null,
  processes:      null,
  jobs:           new JobProvider(),
  users:          null,
  eventLog:       null,
  vpn:            null,
  scheduledTasks: null,
  disks:          null,
  environment:    null,
  remoting:       null,
  roles:          null,
  smb:            null,
  ad:             null,
  computer:       null,
  dns:            null,
  dhcp:           null,
  nps:            null,
  gpo:            null,
  iis:            null,
  exchange:       null,
  adcs:           null,
  pki:            null,
  dfs:            null,
  rdp:            null,
  cluster:        null,
  wsus:           null,
  windowsUpdate:  null,
  print:          null,
  licensing:      null,
};
