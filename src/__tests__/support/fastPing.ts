import { VirtualTimeScheduler } from '@/events/Scheduler';

interface SchedulableHost {
  setScheduler(scheduler: VirtualTimeScheduler | null): void;
  executeCommand(command: string): Promise<string> | string;
}

/**
 * Run a `ping` on the simulated clock instead of the wall clock.
 *
 * `ping -c 3` waits a second between echoes, like the real one — measured,
 * 2005 ms of wall clock for 13 ms of actual echo. That wait is real
 * behaviour and stays: it is the window in which a lab can pull a cable
 * mid-run, and `tracert-ping`'s case 253 does exactly that. What no test
 * needs is to pay for it in REAL seconds, and paying put a whole
 * population of cases at 4.0-4.3 s against vitest's 5 s default, where a
 * loaded run tipped them over.
 *
 * The host is lent a virtual clock for the duration of this one command
 * and handed back its own afterwards, so nothing else in the test changes
 * scheduler — which is what makes this safe to apply at a call site
 * without touching how a lab is built. A test that needs the window
 * itself (acting between two echoes) drives its own clock instead and
 * does not call this.
 */
/** A transcript step whose command is a ping, whatever its options. */
export function isPingStep(command: string): boolean {
  return /^\s*ping6?\s/.test(command);
}

/**
 * True when the device can be lent a clock. A transcript suite drives
 * routers and switches too, and only an end host carries `setScheduler`.
 */
export function canLendClock(device: unknown): boolean {
  return typeof (device as { setScheduler?: unknown })?.setScheduler === 'function';
}

export async function pingOnSimulatedClock(
  host: SchedulableHost,
  command: string,
): Promise<string> {
  const clock = new VirtualTimeScheduler();
  host.setScheduler(clock);
  try {
    return String(await clock.advanceUntilSettled(
      Promise.resolve(host.executeCommand(command)),
    ));
  } finally {
    host.setScheduler(null);
  }
}
