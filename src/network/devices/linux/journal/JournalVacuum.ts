export interface VacuumCandidate {
  readonly name: string;
  readonly usage: number;
  readonly realtime: number;
  readonly seqnumId: string;
  readonly seqnum: number;
  readonly empty: boolean;
}

export interface VacuumLimits {
  readonly maxUse: number;
  readonly maxFiles: number;
  readonly maxRetentionUsec: number;
}

export interface VacuumDeletion {
  readonly name: string;
  readonly usage: number;
  readonly empty: boolean;
}

export interface VacuumPlan {
  readonly deleted: VacuumDeletion[];
  readonly freed: number;
  readonly oldestKeptRealtime: number | null;
}

function compare(a: VacuumCandidate, b: VacuumCandidate): number {
  if (a.seqnumId === b.seqnumId) return a.seqnum - b.seqnum;
  if (a.realtime !== b.realtime) return a.realtime - b.realtime;
  if (a.seqnumId !== b.seqnumId) return a.seqnumId < b.seqnumId ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function planVacuum(archived: readonly VacuumCandidate[], active: { files: number; usage: number }, limits: VacuumLimits, nowUsec: number): VacuumPlan {
  const deleted: VacuumDeletion[] = [];
  if (limits.maxUse <= 0 && limits.maxRetentionUsec <= 0 && limits.maxFiles <= 0) return { deleted, freed: 0, oldestKeptRealtime: null };
  const retentionLimit = limits.maxRetentionUsec > 0 ? Math.max(0, nowUsec - limits.maxRetentionUsec) : 0;
  let sum = active.usage;
  let freed = 0;
  const list: VacuumCandidate[] = [];
  for (const file of archived) {
    if (file.empty) {
      deleted.push({ name: file.name, usage: file.usage, empty: true });
      freed += file.usage;
      continue;
    }
    list.push(file);
    sum += file.usage;
  }
  list.sort(compare);
  let kept = list.length;
  for (let i = 0; i < list.length; i++) {
    const left = active.files + list.length - i;
    if ((limits.maxRetentionUsec <= 0 || list[i].realtime >= retentionLimit) && (limits.maxUse <= 0 || sum <= limits.maxUse) && (limits.maxFiles <= 0 || left <= limits.maxFiles)) {
      kept = i;
      break;
    }
    deleted.push({ name: list[i].name, usage: list[i].usage, empty: false });
    freed += list[i].usage;
    sum = list[i].usage < sum ? sum - list[i].usage : 0;
  }
  return { deleted, freed, oldestKeptRealtime: kept < list.length ? list[kept].realtime : null };
}
