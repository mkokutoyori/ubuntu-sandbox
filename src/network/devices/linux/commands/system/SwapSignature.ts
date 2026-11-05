const MAGIC = 'SWAPSPACE2';
const PAGE_BYTES = 4096;
const HEADER_OFFSET = 1024;

export const SWAP_PAGE_BYTES = PAGE_BYTES;

export interface SwapSignature {
  readonly uuid: string;
  readonly label: string;
}

export function swapHeader(uuid: string, label: string, lastPage: number): string {
  const fields = `1;${lastPage};${uuid};${label}`;
  return '\0'.repeat(HEADER_OFFSET) + fields + '\0'.repeat(PAGE_BYTES - HEADER_OFFSET - fields.length - MAGIC.length) + MAGIC;
}

export function readSwapSignature(content: string): SwapSignature | null {
  if (content.length < PAGE_BYTES || content.slice(PAGE_BYTES - MAGIC.length, PAGE_BYTES) !== MAGIC) return null;
  const [, , uuid = '', label = ''] = content.slice(HEADER_OFFSET, PAGE_BYTES - MAGIC.length).replace(/\0+$/, '').split(';');
  return { uuid, label };
}

export function permissionsText(permissions: number): string {
  return (permissions & 0o7777).toString(8).padStart(4, '0');
}

export function humanSwapSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let unit = 0;
  while (unit < units.length - 1 && bytes >= 1024 ** (unit + 1)) unit++;
  const value = Math.round((bytes / 1024 ** unit) * 10) / 10;
  return `${value}${units[unit]}`;
}
