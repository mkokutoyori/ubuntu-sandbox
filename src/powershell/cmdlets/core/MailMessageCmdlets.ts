/**
 * Send-MailMessage — real `Microsoft.PowerShell.Utility` cmdlet used by
 * admin scripts (password-expiry notifications, monitoring alerts, ...) to
 * relay a message through an SMTP server.
 *
 * Performs a genuine outbound SMTP client transaction (`WindowsPC.
 * sendMailMessage` — real DNS resolution, real `TcpStack` connection,
 * `SmtpClientSession`, the same engine used by `relay.ts`/the Exchange
 * transport pipeline, docs/PRD-SMTP.md §0.2 — no second SMTP engine, no
 * unconditional-success stub). A connection/authentication/relay failure
 * is reported as a real (non-terminating) PowerShell error via
 * `ctx.emitError`, matching real `Send-MailMessage`'s behavior: the
 * calling script keeps executing afterward unless it explicitly checks
 * `$?`/`-ErrorAction Stop`, exactly like every other cmdlet in this
 * registry that can fail without aborting the pipeline.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { isPSCredential, getNetworkCredential } from '@/powershell/credential/PSCredential';

function addressListOf(raw: PSValue): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(psValueToString).filter(Boolean);
  const s = psValueToString(raw);
  return s ? [s] : [];
}

export class SendMailMessageCmdlet implements ICmdlet {
  readonly name = 'send-mailmessage';
  readonly displayName = 'Send-MailMessage';
  readonly aliases = [] as const;
  readonly parameters = [
    'From', 'To', 'Cc', 'Bcc', 'Subject', 'Body', 'BodyAsHtml', 'SmtpServer',
    'Port', 'Credential', 'UseSsl', 'Encoding', 'Priority', 'Attachments',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const from = ctx.named['from'] !== undefined ? psValueToString(ctx.named['from']) : '';
    const to = addressListOf(ctx.named['to']);
    const subject = ctx.named['subject'] !== undefined ? psValueToString(ctx.named['subject']) : '';
    const smtpServer = ctx.named['smtpserver'] !== undefined ? psValueToString(ctx.named['smtpserver']) : '';

    if (!from) { ctx.emitError('Send-MailMessage : Cannot process command because of one or more missing mandatory parameters: From.'); return null; }
    if (to.length === 0) { ctx.emitError('Send-MailMessage : Cannot process command because of one or more missing mandatory parameters: To.'); return null; }
    if (!subject) { ctx.emitError('Send-MailMessage : Cannot process command because of one or more missing mandatory parameters: Subject.'); return null; }
    if (!smtpServer) { ctx.emitError('Send-MailMessage : Cannot process command because of one or more missing mandatory parameters: SmtpServer.'); return null; }

    if (!ctx.providers.network?.sendMailMessage) {
      ctx.emitError('Send-MailMessage : not supported on this device.');
      return null;
    }

    const cc = addressListOf(ctx.named['cc']);
    const bcc = addressListOf(ctx.named['bcc']);
    const body = ctx.named['body'] !== undefined ? psValueToString(ctx.named['body']) : '';
    const port = ctx.named['port'] !== undefined ? Number(psValueToString(ctx.named['port'])) : undefined;
    const useSsl = ctx.named['usessl'] === true;
    const rawCred = ctx.named['credential'];
    const netCred = isPSCredential(rawCred) ? getNetworkCredential(rawCred) : undefined;
    const credential = netCred
      ? { username: netCred.userName, password: netCred.password }
      : undefined;

    const result = ctx.providers.network.sendMailMessage({
      from, to, cc, bcc, subject, body, smtpServer, port, useSsl, credential,
    });
    if (!result.ok) {
      ctx.emitError(result.error ?? 'Send-MailMessage : The message could not be sent.');
      return null;
    }
    return null;
  }
}
