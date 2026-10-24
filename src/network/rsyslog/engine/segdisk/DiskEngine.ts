import type { RsyslogFiles } from '../Host';

export type DiskEngineMode = 'auto' | 'disk' | 'segmentedDisk';
export type ConcreteDiskEngine = 'disk' | 'segmentedDisk';

export type SelectionReason = 'configured' | 'freshDefault' | 'marker' | 'classicData' | 'segmentedData' | 'classicFeature' | 'autoUpgrade';

export interface DiskEngineRequest {
  readonly directory: string;
  readonly prefix: string;
  readonly requested: DiskEngineMode;
  readonly autoUpgrade: boolean;
  readonly requiresClassicFeatures: boolean;
}

export interface DiskEngineSelection {
  readonly effective: ConcreteDiskEngine;
  readonly reason: SelectionReason;
  readonly classicData: boolean;
  readonly segmentedData: boolean;
  readonly markerPresent: boolean;
  readonly markerEngine: ConcreteDiskEngine | null;
}

const MARKER_MAGIC = 'RSYSLOG-DA-ENGINE-V1 ';

export class DiskEngineConflict extends Error {}

function isClassicSegmentName(name: string, prefix: string): boolean {
  return name.startsWith(`${prefix}.`) && /^\d+$/.test(name.slice(prefix.length + 1));
}

function readMarker(files: RsyslogFiles, path: string): ConcreteDiskEngine | null {
  const content = files.read(path);
  if (content === null) return null;
  if (content.length === 0 || content.length >= 64 || !content.startsWith(MARKER_MAGIC) || content.length <= MARKER_MAGIC.length) throw new DiskEngineConflict('malformed engine marker');
  const value = content.slice(MARKER_MAGIC.length);
  if (value === 'disk\n') return 'disk';
  if (value === 'segmentedDisk\n') return 'segmentedDisk';
  throw new DiskEngineConflict('malformed engine marker');
}

export function markerPath(directory: string, prefix: string): string {
  return `${directory}/${prefix}.da-engine`;
}

export function resolveDiskEngine(files: RsyslogFiles, request: DiskEngineRequest): DiskEngineSelection {
  const { directory, prefix } = request;
  const classicIndex = files.lstat(`${directory}/${prefix}.qi`) !== null;
  const segmentedData = files.lstat(`${directory}/${prefix}.segq`) !== null;
  const markerEngine = readMarker(files, markerPath(directory, prefix));
  const numericSegments = files.list(directory).some((name) => isClassicSegmentName(name, prefix));
  const classicData = classicIndex || numericSegments;
  const base = { classicData, segmentedData, markerPresent: markerEngine !== null, markerEngine };
  if (classicData && segmentedData) throw new DiskEngineConflict('classic and segmented data both exist');
  if (markerEngine !== null && ((classicData && markerEngine === 'segmentedDisk') || (segmentedData && markerEngine === 'disk'))) {
    throw new DiskEngineConflict('engine marker contradicts the data on disk');
  }
  if (request.requested === 'disk') {
    if (segmentedData) throw new DiskEngineConflict('segmented data exists');
    return { ...base, effective: 'disk', reason: 'configured' };
  }
  if (request.requested === 'segmentedDisk') {
    if (classicData || request.requiresClassicFeatures) throw new DiskEngineConflict('classic data or classic-only options');
    return { ...base, effective: 'segmentedDisk', reason: 'configured' };
  }
  if (classicData) return { ...base, effective: 'disk', reason: 'classicData' };
  if (segmentedData) {
    if (request.requiresClassicFeatures) throw new DiskEngineConflict('segmented data with classic-only options');
    return { ...base, effective: 'segmentedDisk', reason: 'segmentedData' };
  }
  if (request.requiresClassicFeatures) return { ...base, effective: 'disk', reason: 'classicFeature' };
  if (markerEngine === 'disk' && !request.autoUpgrade) return { ...base, effective: 'disk', reason: 'marker' };
  if (markerEngine === 'disk') return { ...base, effective: 'segmentedDisk', reason: 'autoUpgrade' };
  if (markerEngine !== null) return { ...base, effective: markerEngine, reason: 'marker' };
  return { ...base, effective: 'segmentedDisk', reason: 'freshDefault' };
}

export function writeEngineMarker(files: RsyslogFiles, directory: string, prefix: string, engine: ConcreteDiskEngine, processId: number): boolean {
  const path = markerPath(directory, prefix);
  const temporary = `${path}.tmp.${processId}`;
  if (!files.isDirectory(directory)) return false;
  if (!files.write(temporary, `${MARKER_MAGIC}${engine}\n`)) return false;
  if (files.rename(temporary, path)) return true;
  files.remove(temporary);
  return false;
}
