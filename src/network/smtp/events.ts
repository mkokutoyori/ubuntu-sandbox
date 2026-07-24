export interface SmtpConnectionRef {
  readonly connectionId: string;
}

export interface SmtpCommandReceivedPayload extends SmtpConnectionRef {
  readonly verb: string;
}

export interface SmtpMailPayload extends SmtpConnectionRef {
  readonly envelopeFrom: string;
}

export interface SmtpMailRejectedPayload extends SmtpMailPayload {
  readonly reason: string;
}

export interface SmtpDeliveryPayload {
  readonly recipient: string;
}

export interface SmtpDeliveryDeferredPayload extends SmtpDeliveryPayload {
  readonly reason: string;
}

export interface SmtpAuthPayload extends SmtpConnectionRef {
  readonly mechanism: string;
}

export interface SmtpAuthFailedPayload extends SmtpConnectionRef {
  readonly mechanism: string;
  readonly reason: string;
}

export interface SmtpStartTlsPayload extends SmtpConnectionRef {
  readonly negotiatedCipherSuite: string | null;
}

export interface SmtpDsnGeneratedPayload {
  readonly recipient: string;
  readonly reason: string;
}

export interface SmtpQueueRetriedPayload {
  readonly recipient: string;
  readonly attempt: number;
}

export interface SmtpQueueExpiredPayload {
  readonly recipient: string;
}

export type SmtpDomainEvent =
  | { topic: 'smtp.session.opened'; payload: SmtpConnectionRef }
  | { topic: 'smtp.session.closed'; payload: SmtpConnectionRef }
  | { topic: 'smtp.command.received'; payload: SmtpCommandReceivedPayload }
  | { topic: 'smtp.mail.accepted'; payload: SmtpMailPayload }
  | { topic: 'smtp.mail.rejected'; payload: SmtpMailRejectedPayload }
  | { topic: 'smtp.delivery.local'; payload: SmtpDeliveryPayload }
  | { topic: 'smtp.delivery.relayed'; payload: SmtpDeliveryPayload }
  | { topic: 'smtp.delivery.deferred'; payload: SmtpDeliveryDeferredPayload }
  | { topic: 'smtp.delivery.bounced'; payload: SmtpDeliveryDeferredPayload }
  | { topic: 'smtp.auth.succeeded'; payload: SmtpAuthPayload }
  | { topic: 'smtp.auth.failed'; payload: SmtpAuthFailedPayload }
  | { topic: 'smtp.starttls.established'; payload: SmtpStartTlsPayload }
  | { topic: 'smtp.dsn.generated'; payload: SmtpDsnGeneratedPayload }
  | { topic: 'smtp.queue.retried'; payload: SmtpQueueRetriedPayload }
  | { topic: 'smtp.queue.expired'; payload: SmtpQueueExpiredPayload };

let connectionNonceCounter = 0;

export function randomSmtpConnectionId(): string {
  connectionNonceCounter += 1;
  return `smtp-conn-${connectionNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
