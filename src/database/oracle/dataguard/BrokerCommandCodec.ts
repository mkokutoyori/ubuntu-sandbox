export function encodeBrokerCommand(command: string): string {
  return Array.from(new TextEncoder().encode(command), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeBrokerCommand(hex: string): string {
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
  return new TextDecoder().decode(bytes);
}
