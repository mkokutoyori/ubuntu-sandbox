import type { CaptureFrame } from './CaptureFrame';

export const CAPTURE_FILE_FORMAT_V1 = 'ubuntu-sandbox-capture-v1';

export interface CapturedInterface {
  name: string;
  index: number;
  mac: string | null;
}

export interface CaptureFileHeader {
  linkType: string;
  snaplen: number;
  interfaces: readonly CapturedInterface[];
}

export interface CaptureFile {
  header: CaptureFileHeader;
  frames: CaptureFrame[];
}

interface CaptureFileV1 extends Partial<CaptureFileHeader> {
  format: typeof CAPTURE_FILE_FORMAT_V1;
  frames: readonly CaptureFrame[];
}

const DEFAULT_HEADER: CaptureFileHeader = { linkType: 'EN10MB', snaplen: 262144, interfaces: [] };

export function serializeCaptureFile(
  frames: readonly CaptureFrame[], header: CaptureFileHeader = DEFAULT_HEADER,
): string {
  const payload: CaptureFileV1 = { format: CAPTURE_FILE_FORMAT_V1, ...header, frames };
  return JSON.stringify(payload);
}

export function deserializeCaptureFile(content: string): CaptureFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<CaptureFileV1>;
  if (obj.format !== CAPTURE_FILE_FORMAT_V1 || !Array.isArray(obj.frames)) return null;
  return {
    header: {
      linkType: obj.linkType ?? DEFAULT_HEADER.linkType,
      snaplen: obj.snaplen ?? DEFAULT_HEADER.snaplen,
      interfaces: obj.interfaces ?? [],
    },
    frames: obj.frames.map((f) => ({ ...f, at: new Date(f.at) })),
  };
}
