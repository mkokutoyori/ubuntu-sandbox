const CONNECTION_CONTROL_OPS: ReadonlySet<string> = new Set([
  'keepalive', 'keepalive_ack', 'disconnect',
]);

export function isConnectionControlFrame(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const op = (parsed as { op?: unknown }).op;
  return typeof op === 'string' && CONNECTION_CONTROL_OPS.has(op);
}
