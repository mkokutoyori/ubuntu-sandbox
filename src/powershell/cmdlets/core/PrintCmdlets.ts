/**
 * PrintCmdlets — Print and Document Services minimal (PRD-Windows-Server-
 * Advanced.md §5 P20, §2.1.19): `Add-Printer -ShareName` exposes a shared
 * queue reachable via LPD (`LpdTransport.ts`); `Get-PrintJob`/
 * `Remove-PrintJob` manage it.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IPrintProvider, PrintJobInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requirePrint(ctx: CmdletContext, cmdletName: string): IPrintProvider {
  if (!ctx.providers.print) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.print;
}

function jobToPSObject(j: PrintJobInfo): Record<string, PSValue> {
  return { ID: j.id, DocumentName: j.document, SubmittedBy: j.owner, Size: j.size, JobStatus: j.status };
}

// ── Add-Printer ──────────────────────────────────────────────────────────

export class AddPrinterCmdlet implements ICmdlet {
  readonly name = 'add-printer';
  readonly aliases = [] as const;
  readonly parameters = ['ShareName'] as const;
  readonly displayName = 'Add-Printer';

  execute(ctx: CmdletContext): PSValue {
    const print = requirePrint(ctx, 'Add-Printer');
    const shareName = psValueToString(ctx.named['sharename'] ?? ctx.positional[0] ?? '');
    if (!shareName) {
      ctx.emitError('Add-Printer : Cannot process command because of one or more missing mandatory parameters: ShareName.');
      return null;
    }
    const res = print.addPrinter(shareName);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-PrintJob ─────────────────────────────────────────────────────────

export class GetPrintJobCmdlet implements ICmdlet {
  readonly name = 'get-printjob';
  readonly aliases = [] as const;
  readonly parameters = ['PrinterName'] as const;
  readonly displayName = 'Get-PrintJob';

  execute(ctx: CmdletContext): PSValue {
    const print = requirePrint(ctx, 'Get-PrintJob');
    const printerName = psValueToString(ctx.named['printername'] ?? ctx.positional[0] ?? '');
    if (!printerName) {
      ctx.emitError('Get-PrintJob : Cannot process command because of one or more missing mandatory parameters: PrinterName.');
      return null;
    }
    return print.getPrintJobs(printerName).map(jobToPSObject);
  }
}

// ── Remove-PrintJob ──────────────────────────────────────────────────────

export class RemovePrintJobCmdlet implements ICmdlet {
  readonly name = 'remove-printjob';
  readonly aliases = [] as const;
  readonly parameters = ['PrinterName', 'ID'] as const;
  readonly displayName = 'Remove-PrintJob';

  execute(ctx: CmdletContext): PSValue {
    const print = requirePrint(ctx, 'Remove-PrintJob');
    const printerName = psValueToString(ctx.named['printername'] ?? '');
    const id = Number(psValueToString(ctx.named['id'] ?? ctx.positional[0] ?? ''));
    if (!printerName || Number.isNaN(id)) {
      ctx.emitError('Remove-PrintJob : Cannot process command because of one or more missing mandatory parameters: PrinterName ID.');
      return null;
    }
    const res = print.removePrintJob(printerName, id);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}
