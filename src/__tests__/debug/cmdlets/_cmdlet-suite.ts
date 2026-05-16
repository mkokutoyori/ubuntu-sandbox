/**
 * Shared scaffold for the per-cmdlet attribute debug suites.
 *
 * Each suite exercises ONE cmdlet (or a tight family) with creative,
 * deliberately complex combinations of that cmdlet and its parameters,
 * piped through other cmdlets. Transcripts land in
 * `debug-output/cmdlets/<label>_results_debug.txt` so they stay
 * separate from the behavioural / coherence transcripts.
 */
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runAndDump, createPSRunner, type DebugCommandInput } from '../_dump';

export const CMDLET_SUBDIR = 'cmdlets';

export function resetSim(): void {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
}

/**
 * Run a cmdlet-focused command list through a fresh PowerShell shell on
 * both a workstation and a server (so server-only quirks surface too),
 * dumping each to its own transcript under debug-output/cmdlets/.
 */
export async function dumpCmdletSuite(
  label: string,
  commands: readonly DebugCommandInput[],
): Promise<void> {
  const pc = new WindowsPC('windows-pc', `WIN-${label.toUpperCase()}`);
  const srv = new WindowsPC('windows-server', `SRV-${label.toUpperCase()}`);
  pc.setCurrentUser('Administrator');
  srv.setCurrentUser('Administrator');

  await runAndDump(
    `${label}-pc`,
    commands,
    createPSRunner(pc),
    `host=WIN-${label.toUpperCase()} (windows-pc) — cmdlet attribute suite`,
    CMDLET_SUBDIR,
  );
  await runAndDump(
    `${label}-server`,
    commands,
    createPSRunner(srv),
    `host=SRV-${label.toUpperCase()} (windows-server) — cmdlet attribute suite`,
    CMDLET_SUBDIR,
  );
}
