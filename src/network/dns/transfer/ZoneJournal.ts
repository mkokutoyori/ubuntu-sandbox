import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

export interface ZoneDelta {
  readonly fromSerial: number;
  readonly toSerial: number;
  readonly removals: readonly ResourceRecord<ResourceRecordData>[];
  readonly additions: readonly ResourceRecord<ResourceRecordData>[];
}

const DEFAULT_JOURNAL_LIMIT = 64;

export class ZoneJournal {
  private readonly deltas: ZoneDelta[] = [];

  constructor(private readonly limit: number = DEFAULT_JOURNAL_LIMIT) {}

  record(delta: ZoneDelta): void {
    this.deltas.push(delta);
    while (this.deltas.length > this.limit) {
      this.deltas.shift();
    }
  }

  deltasSince(serial: number): ZoneDelta[] | null {
    const start = this.deltas.findIndex((delta) => delta.fromSerial === serial);
    if (start === -1) return null;

    const chain: ZoneDelta[] = [];
    let expected = serial;
    for (const delta of this.deltas.slice(start)) {
      if (delta.fromSerial !== expected) return null;
      chain.push(delta);
      expected = delta.toSerial;
    }
    return chain;
  }
}
