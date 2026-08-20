/**
 * PrintServerRole — Print and Document Services minimal (PRD-Windows-
 * Server-Advanced.md §5 P20, §2.1.19). A shared print queue per
 * `Add-Printer -ShareName`, fed by real LPD (RFC 1179) submissions from
 * remote hosts over TCP/515 (`LpdTransport.ts`). Reuses the `PrintJob`
 * structure already defined client-side in `WinPrint.ts` — no real
 * document rendering, only the acknowledgement/queue-progression state
 * that structure already models.
 */
import type { PrintJob } from '@/network/devices/windows/WinPrint';

export interface PrintOpResult { ok: boolean; message: string }

/** One shared printer's job queue. */
class SharedPrintQueue {
  private readonly jobs: PrintJob[] = [];
  private nextId = 1;

  submit(document: string, owner: string, sizeBytes: number): PrintJob {
    const job: PrintJob = {
      id: this.nextId++, document, owner,
      submittedAt: new Date(), size: sizeBytes, status: 'Printing',
    };
    this.jobs.push(job);
    return job;
  }

  list(): PrintJob[] { return [...this.jobs]; }

  remove(jobId: number): boolean {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx < 0) return false;
    this.jobs.splice(idx, 1);
    return true;
  }
}

/** Owned by one `WindowsServer`'s `Print-Services` role install — every shared printer's queue. */
export class WindowsPrintServerRole {
  private readonly printers = new Map<string, SharedPrintQueue>();

  /** `Add-Printer -ShareName <name>` — exposes a new shared queue, reachable via LPD on this printer's queue name. */
  addPrinter(shareName: string): PrintOpResult {
    const key = shareName.toLowerCase();
    if (this.printers.has(key)) {
      return { ok: false, message: `Add-Printer : Printer "${shareName}" already exists.` };
    }
    this.printers.set(key, new SharedPrintQueue());
    return { ok: true, message: '' };
  }

  hasPrinter(shareName: string): boolean { return this.printers.has(shareName.toLowerCase()); }

  /** LPD "Receive a printer job" — called once a full control+data file exchange completes. */
  submitJob(shareName: string, document: string, owner: string, sizeBytes: number): PrintJob | null {
    const queue = this.printers.get(shareName.toLowerCase());
    if (!queue) return null;
    return queue.submit(document, owner, sizeBytes);
  }

  /** `Get-PrintJob` — every job in `shareName`'s queue. */
  listJobs(shareName: string): PrintJob[] {
    return this.printers.get(shareName.toLowerCase())?.list() ?? [];
  }

  /** `Remove-PrintJob -PrinterName <shareName> -ID <jobId>`. */
  removeJob(shareName: string, jobId: number): PrintOpResult {
    const queue = this.printers.get(shareName.toLowerCase());
    if (!queue || !queue.remove(jobId)) {
      return { ok: false, message: `Remove-PrintJob : No job with ID ${jobId} was found on "${shareName}".` };
    }
    return { ok: true, message: '' };
  }
}
