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

export const NULL_PROVIDERS: PSProviders = {
  filesystem:     new SimulatedFileSystem(),
  registry:       null,
  services:       null,
  network:        null,
  processes:      null,
  users:          null,
  eventLog:       null,
  vpn:            null,
  scheduledTasks: null,
  disks:          null,
};
