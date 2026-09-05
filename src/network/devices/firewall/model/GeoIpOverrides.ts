import { matchesRange } from './AddressObject';

export interface GeoIpRange {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export interface GeoIpOverride {
  readonly name: string;
  readonly countryId: string;
  readonly description?: string;
  readonly ranges: readonly GeoIpRange[];
}

export class GeoIpOverrides {
  private readonly overrides = new Map<string, GeoIpOverride>();

  apply(override: GeoIpOverride): void {
    this.overrides.set(override.name, Object.freeze({
      ...override,
      countryId: override.countryId.toUpperCase(),
      ranges: Object.freeze([...override.ranges]),
    }));
  }

  remove(name: string): boolean {
    return this.overrides.delete(name);
  }

  list(): readonly GeoIpOverride[] {
    return Object.freeze([...this.overrides.values()]);
  }

  countryOf(candidate: string): string | undefined {
    for (const override of this.overrides.values()) {
      if (override.countryId.length === 0) continue;
      for (const range of override.ranges) {
        if (matchesRange(candidate, range.from, range.to)) return override.countryId;
      }
    }
    return undefined;
  }
}
