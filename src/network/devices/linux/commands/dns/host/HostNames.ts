import { isIPv4Literal, isIPv6Literal, ptrQName } from '@/network/dns/compat/DnsWireCompat';

export interface DnsNameText {
  readonly labels: readonly string[];
  readonly absolute: boolean;
}

export type DnsNameParse = { readonly name: DnsNameText } | { readonly error: string };

const MAX_LABEL_LENGTH = 63;
const MAX_NAME_LENGTH = 255;
const DECIMAL_ESCAPE_DIGITS = 3;
const FIRST_DISPLAYABLE = 0x21;
const LAST_DISPLAYABLE = 0x7e;
const ESCAPED_WITH_BACKSLASH = new Set(['"', '(', ')', '.', ';', '\\', '@', '$']);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

export function parseDnsNameText(text: string): DnsNameParse {
  if (text === '') return { error: 'unexpected end of input' };
  if (text === '.') return { name: { labels: [], absolute: true } };
  const labels: string[] = [];
  let label = '';
  let wireLength = 1;
  const seal = (): string | null => {
    if (label === '') return 'empty label';
    if (label.length > MAX_LABEL_LENGTH) return 'label too long';
    wireLength += label.length + 1;
    if (wireLength > MAX_NAME_LENGTH) return 'ran out of space';
    labels.push(label);
    label = '';
    return null;
  };
  let absolute = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') {
      const next = text[index + 1];
      if (next === undefined) return { error: 'unexpected end of input' };
      if (isDigit(next)) {
        const digits = text.slice(index + 1, index + 1 + DECIMAL_ESCAPE_DIGITS);
        if (!/^\d{3}$/.test(digits) || Number(digits) > 255) return { error: 'bad escape' };
        label += String.fromCharCode(Number(digits));
        index += DECIMAL_ESCAPE_DIGITS;
      } else {
        label += next;
        index += 1;
      }
      continue;
    }
    if (char === '.') {
      const problem = seal();
      if (problem !== null) return { error: problem };
      absolute = index === text.length - 1;
      continue;
    }
    label += char;
  }
  if (!absolute) {
    const problem = seal();
    if (problem !== null) return { error: problem };
  }
  return { name: { labels, absolute } };
}

function escapedLabel(label: string): string {
  let text = '';
  for (const char of label) {
    const code = char.charCodeAt(0);
    if (ESCAPED_WITH_BACKSLASH.has(char)) text += `\\${char}`;
    else if (code < FIRST_DISPLAYABLE || code > LAST_DISPLAYABLE) text += `\\${String(code).padStart(DECIMAL_ESCAPE_DIGITS, '0')}`;
    else text += char;
  }
  return text;
}

export function formatDnsName(labels: readonly string[]): string {
  return labels.length === 0 ? '.' : labels.map(escapedLabel).join('.');
}

export function countDots(text: string): number {
  return text.split('.').length - 1;
}

export function reverseNameOf(text: string): string | null {
  if (!text.includes('%') && isIPv6Literal(text)) return ptrQName(text);
  if (isIPv4Literal(text)) return `${ptrQName(text)}.`;
  return null;
}
