/**
 * Shared process-address encoding for V$PROCESS.ADDR and V$SESSION.PADDR.
 *
 * Both views derive the address from the process PID so the canonical
 * DBA join — `v$session s, v$process p WHERE s.paddr = p.addr` — works.
 * Before this, each view invented its own scheme and the join returned
 * nothing.
 */
export function processAddr(pid: number): string {
  return `00000000${(0x7f000000 + pid * 0x40).toString(16).padStart(8, '0').toUpperCase()}`;
}
