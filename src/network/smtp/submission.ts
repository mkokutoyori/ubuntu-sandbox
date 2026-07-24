export interface SubmissionContext {
  readonly authenticatedIdentity: string;
  readonly declaredFrom: string;
  readonly senderHeaderAdded: boolean;
}

export function identityMatchesFrom(authenticatedIdentity: string, declaredFrom: string): boolean {
  return declaredFrom.toLowerCase().includes(authenticatedIdentity.toLowerCase());
}

export function buildSubmissionContext(authenticatedIdentity: string, declaredFrom: string): SubmissionContext {
  return { authenticatedIdentity, declaredFrom, senderHeaderAdded: !identityMatchesFrom(authenticatedIdentity, declaredFrom) };
}

export function formatSenderLine(authenticatedIdentity: string, hostname: string): string {
  const address = authenticatedIdentity.includes('@') ? authenticatedIdentity : `${authenticatedIdentity}@${hostname}`;
  return `Sender: <${address}>`;
}

export function insertSenderHeader(rawMessage: string, senderLine: string): string {
  return `${senderLine}\r\n${rawMessage}`;
}
