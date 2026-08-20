import { RRType } from '@/network/dns/wire/RRType';
import { Zone, ZoneError } from '@/network/dns/zone/Zone';
import { buildAxfrAnswers } from '@/network/dns/transfer/AxfrSession';
import type { ZoneJournal } from '@/network/dns/transfer/ZoneJournal';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';

function soaWithSerial(zone: Zone, serial: number): ResourceRecord<ResourceRecordData> {
  const soa = zone.soa;
  return { ...soa, data: { ...soa.data, serial } } as ResourceRecord<ResourceRecordData>;
}

export function buildIxfrAnswers(
  zone: Zone, journal: ZoneJournal, clientSerial: number,
): ResourceRecord<ResourceRecordData>[] {
  const current = zone.soa as ResourceRecord<ResourceRecordData>;
  if (clientSerial === zone.soa.data.serial) {
    return [current];
  }

  const deltas = journal.deltasSince(clientSerial);
  if (!deltas) {
    return buildAxfrAnswers(zone);
  }

  const answers: ResourceRecord<ResourceRecordData>[] = [current];
  for (const delta of deltas) {
    answers.push(soaWithSerial(zone, delta.fromSerial), ...delta.removals);
    answers.push(soaWithSerial(zone, delta.toSerial), ...delta.additions);
  }
  answers.push(current);
  return answers;
}

export function isDeltaTransfer(answers: readonly ResourceRecord<ResourceRecordData>[]): boolean {
  return answers.length > 1 && answers[1].data.type === RRType.SOA;
}

export function applyIxfrDeltas(zone: Zone, answers: readonly ResourceRecord<ResourceRecordData>[]): void {
  const last = answers.length - 1;
  let idx = 1;

  while (idx < last) {
    const oldSoa = answers[idx];
    if (oldSoa.data.type !== RRType.SOA) {
      throw new ZoneError('malformed IXFR delta: expected the pre-change SOA marker');
    }
    if ((oldSoa.data as SoaRecordData).serial !== zone.soa.data.serial) {
      throw new ZoneError(
        `IXFR delta starts at serial ${(oldSoa.data as SoaRecordData).serial} ` +
        `but the local zone is at ${zone.soa.data.serial}`);
    }
    idx++;

    const removals: ResourceRecord<ResourceRecordData>[] = [];
    while (idx < last && answers[idx].data.type !== RRType.SOA) {
      removals.push(answers[idx]);
      idx++;
    }

    const newSoa = answers[idx];
    if (newSoa?.data.type !== RRType.SOA) {
      throw new ZoneError('malformed IXFR delta: expected the post-change SOA marker');
    }
    idx++;

    const additions: ResourceRecord<ResourceRecordData>[] = [];
    while (idx < last && answers[idx].data.type !== RRType.SOA) {
      additions.push(answers[idx]);
      idx++;
    }

    for (const rr of removals) zone.removeRecord(rr);
    for (const rr of additions) zone.addRecord(rr);
    zone.updateSoa(newSoa as ResourceRecord<SoaRecordData>);
  }
}
