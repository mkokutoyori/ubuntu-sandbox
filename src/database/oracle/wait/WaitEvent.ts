/**
 * WaitEvent — concrete Oracle wait-event definition.
 *
 * Real Oracle's catalogue lives in V$EVENT_NAME; each row carries the
 * event's numeric id, name, parameter labels (P1, P2, P3) and the
 * wait class it belongs to ("User I/O", "Network", "Application", …).
 *
 * The simulator ships the canonical Oracle 19c subset that appears
 * during normal SQL workload: enough that DBA scripts joining on
 * V$EVENT_NAME find the events they look for.
 */

export type WaitClass =
  | 'User I/O' | 'System I/O' | 'Network'
  | 'Concurrency' | 'Application' | 'Configuration'
  | 'Commit' | 'Idle' | 'Other' | 'Scheduler' | 'Cluster';

export class WaitEvent {
  constructor(
    readonly eventId: number,
    readonly name: string,
    readonly waitClass: WaitClass,
    readonly waitClassId: number,
    readonly parameter1: string = '',
    readonly parameter2: string = '',
    readonly parameter3: string = '',
  ) {}
}

const WAIT_CLASSES: Record<WaitClass, number> = {
  'Other':         0,
  'Application':   4217450380,
  'Configuration': 3290255840,
  'Administrative':                        2147483647,
  'Concurrency':   3875070507,
  'Commit':        3386400367,
  'Idle':          2723168908,
  'Network':       2000153315,
  'User I/O':      1740759767,
  'System I/O':    4108307767,
  'Scheduler':     2396326234,
  'Cluster':       3871361733,
} as Record<WaitClass, number>;

/** Canonical Oracle 19c wait-event catalogue (subset). */
export const KNOWN_WAIT_EVENTS: WaitEvent[] = [
  // User I/O
  new WaitEvent(1740759767, 'db file sequential read',        'User I/O',    WAIT_CLASSES['User I/O'],    'file#', 'block#', 'blocks'),
  new WaitEvent(1740759768, 'db file scattered read',         'User I/O',    WAIT_CLASSES['User I/O'],    'file#', 'block#', 'blocks'),
  new WaitEvent(1740759769, 'direct path read',               'User I/O',    WAIT_CLASSES['User I/O'],    'file number', 'first dba', 'block cnt'),
  new WaitEvent(1740759770, 'direct path write',              'User I/O',    WAIT_CLASSES['User I/O'],    'file number', 'first dba', 'block cnt'),
  // System I/O
  new WaitEvent(4108307767, 'control file sequential read',   'System I/O',  WAIT_CLASSES['System I/O'],  'file#', 'block#', 'blocks'),
  new WaitEvent(4108307768, 'log file sequential read',       'System I/O',  WAIT_CLASSES['System I/O'],  'log#', 'block#', 'blocks'),
  new WaitEvent(4108307769, 'log file parallel write',        'System I/O',  WAIT_CLASSES['System I/O'],  'files', 'blocks', 'requests'),
  // Network
  new WaitEvent(2000153315, 'SQL*Net message from client',    'Idle',        WAIT_CLASSES['Idle'],        'driver id', '#bytes'),
  new WaitEvent(2000153316, 'SQL*Net message to client',      'Network',     WAIT_CLASSES['Network'],     'driver id', '#bytes'),
  new WaitEvent(2000153317, 'SQL*Net more data from client',  'Network',     WAIT_CLASSES['Network'],     'driver id', '#bytes'),
  // Commit
  new WaitEvent(3386400367, 'log file sync',                  'Commit',      WAIT_CLASSES['Commit'],      'buffer#'),
  // Concurrency
  new WaitEvent(3875070507, 'library cache lock',             'Concurrency', WAIT_CLASSES['Concurrency'], 'handle address', 'lock address', '100*mode+namespace'),
  new WaitEvent(3875070508, 'enq: TX - row lock contention',  'Application', WAIT_CLASSES['Application'], 'name|mode', 'usn<<16 | slot', 'sequence'),
  new WaitEvent(3875070509, 'latch: shared pool',             'Concurrency', WAIT_CLASSES['Concurrency'], 'address', 'number', 'tries'),
  // Idle
  new WaitEvent(2723168908, 'PX Idle Wait',                   'Idle',        WAIT_CLASSES['Idle']),
  new WaitEvent(2723168909, 'pmon timer',                     'Idle',        WAIT_CLASSES['Idle']),
];

/** Look up a wait event by name. */
export function findWaitEvent(name: string): WaitEvent | undefined {
  return KNOWN_WAIT_EVENTS.find(e => e.name.toLowerCase() === name.toLowerCase());
}
