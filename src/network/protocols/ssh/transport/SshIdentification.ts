export const MAX_IDENTIFICATION_LENGTH = 255;

export interface SshIdentification {
  readonly line: string;
  readonly protoVersion: string;
  readonly softwareVersion: string;
  readonly comments: string | null;
}

export function identificationLine(identification: string): string {
  return `${identification}\r\n`;
}

export function parseIdentification(line: string): SshIdentification | null {
  if (!line.startsWith('SSH-') || line.length + 2 > MAX_IDENTIFICATION_LENGTH || line.includes('\0')) return null;
  const rest = line.slice(4);
  const dash = rest.indexOf('-');
  if (dash <= 0) return null;
  const protoVersion = rest.slice(0, dash);
  const software = rest.slice(dash + 1);
  const space = software.indexOf(' ');
  const softwareVersion = space < 0 ? software : software.slice(0, space);
  if (softwareVersion === '') return null;
  return {
    line,
    protoVersion,
    softwareVersion,
    comments: space < 0 ? null : software.slice(space + 1),
  };
}

export type IdentificationScan =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'found'; readonly identification: SshIdentification; readonly consumed: number;
    readonly preambleLines: readonly string[] }
  | { readonly kind: 'invalid'; readonly line: string };

export function scanIdentification(buffered: string): IdentificationScan {
  const preambleLines: string[] = [];
  let offset = 0;
  for (;;) {
    const end = buffered.indexOf('\n', offset);
    if (end < 0) {
      return buffered.length - offset > MAX_IDENTIFICATION_LENGTH
        ? { kind: 'invalid', line: buffered.slice(offset) }
        : { kind: 'incomplete' };
    }
    const raw = buffered.slice(offset, end);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    offset = end + 1;
    if (!line.startsWith('SSH-')) {
      preambleLines.push(line);
      continue;
    }
    const identification = parseIdentification(line);
    if (!identification) return { kind: 'invalid', line };
    return { kind: 'found', identification, consumed: offset, preambleLines };
  }
}
