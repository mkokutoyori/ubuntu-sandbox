import type { CaptureFrame } from './CaptureFrame';

export const CAPTURE_FILE_FORMAT_V1 = 'ubuntu-sandbox-capture-v1';

interface CaptureFileV1 {
  format: typeof CAPTURE_FILE_FORMAT_V1;
  frames: readonly CaptureFrame[];
}

export function serializeCaptureFile(frames: readonly CaptureFrame[]): string {
  const payload: CaptureFileV1 = { format: CAPTURE_FILE_FORMAT_V1, frames };
  return JSON.stringify(payload);
}

export function deserializeCaptureFile(content: string): CaptureFrame[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<CaptureFileV1>;
  if (obj.format !== CAPTURE_FILE_FORMAT_V1 || !Array.isArray(obj.frames)) return null;
  return obj.frames.map((f) => ({ ...f, at: new Date(f.at) }));
}
