/**
 * `print` — submit a file to the default printer.
 *
 * Gated on the Print Spooler service. The simulator does not actually
 * render anything; it just acknowledges the spool submission so any
 * dump-driven scenarios see the expected line and the queue grows.
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';

export type PrintJobStatus = 'Spooling' | 'Printing' | 'Completed' | 'Error';

export interface PrintJob {
  id: number;
  document: string;
  owner: string;
  submittedAt: Date;
  /** Approximate byte count. */
  size: number;
  /** Queue progression (PRD-Windows-Server-Advanced.md §5 P20) — no real document rendering, only acknowledgement/queue state. */
  status: PrintJobStatus;
}

const QUEUES = new Map<string, PrintJob[]>();

function getQueue(ctx: WinCommandContext): PrintJob[] {
  let q = QUEUES.get(ctx.hostname);
  if (!q) { q = []; QUEUES.set(ctx.hostname, q); }
  return q;
}

export function cmdPrint(ctx: WinCommandContext, args: string[]): string {
  const gate = requireWindowsService(ctx, 'Spooler');
  if (!gate.ok) return gate.error;

  if (args.length === 0) {
    return `Usage: PRINT [/D:device] [[drive:][path]filename[...]]`;
  }
  // /D:device flag — strip it for the printer name.
  const deviceArg = args.find(a => /^\/D:/i.test(a));
  const printer = deviceArg ? deviceArg.slice(3) : 'Microsoft Print to PDF';
  const files = args.filter(a => !a.startsWith('/'));
  if (files.length === 0) {
    return `Usage: PRINT [/D:device] [[drive:][path]filename[...]]`;
  }

  const queue = getQueue(ctx);
  const lines: string[] = [];
  for (const f of files) {
    queue.push({
      id: queue.length + 1,
      document: f,
      owner: 'Administrator',
      submittedAt: new Date(),
      size: 1024,
      status: 'Printing',
    });
    lines.push(`${f} is currently being printed on ${printer}.`);
  }
  return lines.join('\n');
}
