import type { TablespacePayload } from '../OracleStorage';

const PAYLOAD_MARKER = 'ORACLE-SEGMENT-IMAGE';

export function renderDatafileImage(banner: string, payload: TablespacePayload | null): string {
  if (!payload) return banner;
  return `${banner}\n${PAYLOAD_MARKER} ${JSON.stringify(payload)}\n`;
}

export function datafileBannerOf(text: string): string {
  const firstLine = text.split('\n', 1)[0];
  return firstLine ?? '';
}

export function parseDatafileImage(text: string | null): TablespacePayload | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.startsWith(`${PAYLOAD_MARKER} `));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(PAYLOAD_MARKER.length + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<TablespacePayload>;
    if (typeof candidate.tablespace !== 'string' || !Array.isArray(candidate.tables)) return null;
    return candidate as TablespacePayload;
  } catch {
    return null;
  }
}
