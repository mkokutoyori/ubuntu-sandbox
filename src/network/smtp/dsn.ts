import type { IEventBus } from '@/events/EventBus';

const CRLF = '\r\n';

export type DsnNotifyCondition = 'SUCCESS' | 'FAILURE' | 'DELAY' | 'NEVER';

export interface DsnRequest {
  readonly notify: readonly DsnNotifyCondition[];
  readonly orcpt?: string;
}

export type DsnAction = 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded';

export interface DsnReport {
  readonly finalRecipient: string;
  readonly action: DsnAction;
  readonly status: string;
  readonly diagnosticCode?: string;
  readonly originalEnvelopeId?: string;
}

const NOTIFY_CONDITIONS: readonly DsnNotifyCondition[] = ['SUCCESS', 'FAILURE', 'DELAY', 'NEVER'];

export function parseNotifyParam(argument: string | undefined): readonly DsnNotifyCondition[] {
  const m = /\bNOTIFY=([A-Z,]+)/i.exec(argument ?? '');
  if (!m) return [];
  const tokens = m[1].toUpperCase().split(',');
  return tokens.filter((t): t is DsnNotifyCondition => (NOTIFY_CONDITIONS as readonly string[]).includes(t));
}

export function parseOrcptParam(argument: string | undefined): string | undefined {
  const m = /\bORCPT=rfc822;(\S+)/i.exec(argument ?? '');
  return m ? m[1] : undefined;
}

export function parseRcptDsnParams(argument: string | undefined): DsnRequest {
  return { notify: parseNotifyParam(argument), orcpt: parseOrcptParam(argument) };
}

export function isBounceEnvelope(envelopeFrom: string): boolean {
  return envelopeFrom === '';
}

export function shouldGenerateDsn(originalEnvelopeFrom: string, notify: readonly DsnNotifyCondition[]): boolean {
  if (isBounceEnvelope(originalEnvelopeFrom)) return false;
  if (notify.includes('NEVER')) return false;
  return true;
}

export function formatDeliveryStatusPart(report: DsnReport): string {
  const lines = [
    `Final-Recipient: rfc822;${report.finalRecipient}`,
    `Action: ${report.action}`,
    `Status: ${report.status}`,
  ];
  if (report.diagnosticCode) lines.push(`Diagnostic-Code: ${report.diagnosticCode}`);
  if (report.originalEnvelopeId) lines.push(`Original-Envelope-Id: ${report.originalEnvelopeId}`);
  return lines.join(CRLF);
}

export function buildDsnMessage(report: DsnReport, originalMessageHeaders?: string, boundary = 'DSN-BOUNDARY'): string {
  const parts: string[] = [
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    'Subject: Delivery Status Notification (Failure)',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'Delivery to the following recipient failed permanently:',
    '',
    `  ${report.finalRecipient}`,
    '',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    formatDeliveryStatusPart(report),
    '',
  ];
  if (originalMessageHeaders) {
    parts.push(`--${boundary}`, 'Content-Type: message/rfc822', '', originalMessageHeaders, '');
  }
  parts.push(`--${boundary}--`);
  return parts.join(CRLF);
}

export interface DsnDispatch {
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly message: string;
}

export function buildDsnForFailedDelivery(
  originalEnvelopeFrom: string,
  recipient: string,
  rawFailureReason: string,
  dsnRequest: DsnRequest,
  originalMessageHeaders?: string,
  eventBus?: IEventBus,
): DsnDispatch | null {
  if (!shouldGenerateDsn(originalEnvelopeFrom, dsnRequest.notify)) return null;
  const report: DsnReport = {
    finalRecipient: recipient,
    action: 'failed',
    status: '5.1.1',
    diagnosticCode: `smtp; ${rawFailureReason}`,
    originalEnvelopeId: dsnRequest.orcpt,
  };
  eventBus?.publish({ topic: 'smtp.dsn.generated', payload: { recipient, reason: rawFailureReason } });
  return {
    envelopeFrom: '',
    envelopeTo: dsnRequest.orcpt ?? originalEnvelopeFrom,
    message: buildDsnMessage(report, originalMessageHeaders),
  };
}
