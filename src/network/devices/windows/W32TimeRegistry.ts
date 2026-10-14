import { parseRegistryAddress, type RegistryValueType } from './PSRegistryProvider';

export const W32TIME_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\W32Time';
export const W32TIME_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\W32time';
export const W32TIME_PARAMETERS_KEY = `${W32TIME_KEY}\\Parameters`;
export const W32TIME_CONFIG_KEY = `${W32TIME_KEY}\\Config`;
export const W32TIME_NTP_CLIENT_KEY = `${W32TIME_KEY}\\TimeProviders\\NtpClient`;
export const W32TIME_NTP_SERVER_KEY = `${W32TIME_KEY}\\TimeProviders\\NtpServer`;

export interface W32TimeRegistryPort {
  getItemPropertyValues(path: string): Record<string, string | number> | null;
  setValue(address: NonNullable<ReturnType<typeof parseRegistryAddress>>, name: string, type: RegistryValueType, value: string | number): boolean;
}

interface Seed {
  readonly key: string;
  readonly name: string;
  readonly type: RegistryValueType;
  readonly value: string | number;
}

export interface W32TimeSeedOptions {
  readonly serverEdition: boolean;
  readonly domainMember: boolean;
}

export function w32timeSeeds(options: W32TimeSeedOptions): Seed[] {
  const dll = '%systemroot%\\system32\\w32time.dll';
  const configSeeds: Array<[string, number]> = [
    ['AnnounceFlags', 10], ['EventLogFlags', 2], ['FrequencyCorrectRate', 4], ['HoldPeriod', 5],
    ['LargePhaseOffset', 50000000], ['LastClockRate', 156250], ['LocalClockDispersion', 10],
    ['MaxAllowedPhaseOffset', options.serverEdition ? 300 : 1], ['MaxClockRate', 155860],
    ['MaxNegPhaseCorrection', 54000], ['MaxPollInterval', 10], ['MaxPosPhaseCorrection', 54000],
    ['MinClockRate', 156640], ['MinPollInterval', 6], ['PhaseCorrectRate', options.serverEdition ? 7 : 1],
    ['PollAdjustFactor', 5], ['SpikeWatchPeriod', 90], ['TimeJumpAuditOffset', 28800],
    ['UpdateInterval', 100], ['UtilizeSslTimeData', 1],
  ];
  const seeds: Seed[] = [
    { key: W32TIME_PARAMETERS_KEY, name: 'ServiceDll', type: 'ExpandString', value: dll },
    { key: W32TIME_PARAMETERS_KEY, name: 'ServiceDllUnloadOnStop', type: 'DWord', value: 1 },
    { key: W32TIME_PARAMETERS_KEY, name: 'ServiceMain', type: 'String', value: 'SvchostEntry_W32Time' },
    { key: W32TIME_PARAMETERS_KEY, name: 'Type', type: 'String', value: options.domainMember ? 'NT5DS' : 'NTP' },
    { key: W32TIME_PARAMETERS_KEY, name: 'NtpServer', type: 'String', value: 'time.windows.com,0x9' },
    ...configSeeds.map(([name, value]): Seed => ({ key: W32TIME_CONFIG_KEY, name, type: 'DWord', value })),
    { key: W32TIME_NTP_CLIENT_KEY, name: 'AllowNonstandardModeCombinations', type: 'DWord', value: 1 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'CompatibilityFlags', type: 'DWord', value: 2147483648 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'CrossSiteSyncFlags', type: 'DWord', value: 2 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'DllName', type: 'ExpandString', value: dll },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'Enabled', type: 'DWord', value: 1 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'EventLogFlags', type: 'DWord', value: 1 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'InputProvider', type: 'DWord', value: 1 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'LargeSampleSkew', type: 'DWord', value: 3 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'ResolvePeerBackoffMaxTimes', type: 'DWord', value: 7 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'ResolvePeerBackoffMinutes', type: 'DWord', value: 15 },
    { key: W32TIME_NTP_CLIENT_KEY, name: 'SpecialPollInterval', type: 'DWord', value: options.domainMember ? 3600 : 604800 },
    { key: W32TIME_NTP_SERVER_KEY, name: 'AllowNonstandardModeCombinations', type: 'DWord', value: 1 },
    { key: W32TIME_NTP_SERVER_KEY, name: 'DllName', type: 'ExpandString', value: dll },
    { key: W32TIME_NTP_SERVER_KEY, name: 'Enabled', type: 'DWord', value: 0 },
    { key: W32TIME_NTP_SERVER_KEY, name: 'InputProvider', type: 'DWord', value: 0 },
  ];
  return seeds;
}

export class W32TimeRegistry {
  constructor(private readonly registry: W32TimeRegistryPort) {}

  seed(options: W32TimeSeedOptions): void {
    for (const seed of w32timeSeeds(options)) {
      if (this.has(seed.key, seed.name)) continue;
      this.write(seed.key, seed.name, seed.type, seed.value);
    }
  }

  private values(key: string): Record<string, string | number> {
    return this.registry.getItemPropertyValues(key) ?? {};
  }

  private has(key: string, name: string): boolean {
    const wanted = name.toLowerCase();
    return Object.keys(this.values(key)).some((existing) => existing.toLowerCase() === wanted);
  }

  read(key: string, name: string): string | number | undefined {
    const wanted = name.toLowerCase();
    for (const [existing, value] of Object.entries(this.values(key))) {
      if (existing.toLowerCase() === wanted) return value;
    }
    return undefined;
  }

  readEffective(key: string, name: string): { value: string | number | undefined; origin: 'Policy' | 'Local' } {
    const policy = this.read(key.replace(W32TIME_KEY, W32TIME_POLICY_KEY), name);
    if (policy !== undefined) return { value: policy, origin: 'Policy' };
    return { value: this.read(key, name), origin: 'Local' };
  }

  readNumber(key: string, name: string, fallback: number): number {
    const raw = this.readEffective(key, name).value;
    if (raw === undefined) return fallback;
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    return Number.isFinite(value) ? value : fallback;
  }

  readText(key: string, name: string, fallback = ''): string {
    const raw = this.readEffective(key, name).value;
    return raw === undefined ? fallback : String(raw);
  }

  write(key: string, name: string, type: RegistryValueType, value: string | number): void {
    const address = parseRegistryAddress(key);
    if (address !== null) this.registry.setValue(address, name, type, value);
  }

  writeNumber(key: string, name: string, value: number): void {
    this.write(key, name, 'DWord', value);
  }

  entries(key: string): Array<[string, string | number]> {
    return Object.entries(this.values(key));
  }
}
