import { TimeZone } from '@/network/core/time/TimeZone';
import { offsetMinutesAt } from '@/network/core/time/TimeZoneRegistry';
import { syslogTimeFromEpochMs, TIME_TYPE_RFC5424, type SyslogTime } from '@/network/syslog/codec/SyslogTime';
import type { RsyslogHost } from './Host';

export class LocalClock {
  constructor(private readonly host: RsyslogHost, private readonly overrides: () => ReadonlyMap<string, { offsetMinutes: number }>) {}

  private timezone(): TimeZone {
    return TimeZone.parse(this.host.timezone() ?? 'UTC') ?? TimeZone.UTC;
  }

  at(epochMs: number): SyslogTime {
    const zone = this.timezone();
    const override = this.overrides().get(zone.name);
    const offset = override?.offsetMinutes ?? offsetMinutesAt(zone, epochMs);
    return syslogTimeFromEpochMs(epochMs, offset, 6, TIME_TYPE_RFC5424);
  }

  now(): SyslogTime {
    return this.at(this.host.clock.wallMs());
  }

  utcNow(): SyslogTime {
    return syslogTimeFromEpochMs(this.host.clock.wallMs(), 0, 6, TIME_TYPE_RFC5424);
  }
}
