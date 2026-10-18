export const INTERNATIONAL_KEY = 'HKCU:\\Control Panel\\International';

export type DateOrder = 'MDY' | 'DMY' | 'YMD';

export interface WindowsCulture {
  readonly name: string;
  readonly lcid: number;
  readonly displayName: string;
  readonly shortDate: string;
  readonly timeFormat: string;
  readonly countryCode: number;
  readonly countryName: string;
  readonly languageAbbreviation: string;
}

export const WINDOWS_CULTURES: readonly WindowsCulture[] = [
  { name: 'en-US', lcid: 1033, displayName: 'English (United States)', shortDate: 'M/d/yyyy', timeFormat: 'h:mm:ss tt', countryCode: 1, countryName: 'United States', languageAbbreviation: 'ENU' },
  { name: 'en-GB', lcid: 2057, displayName: 'English (United Kingdom)', shortDate: 'dd/MM/yyyy', timeFormat: 'HH:mm:ss', countryCode: 44, countryName: 'United Kingdom', languageAbbreviation: 'ENG' },
  { name: 'fr-FR', lcid: 1036, displayName: 'French (France)', shortDate: 'dd/MM/yyyy', timeFormat: 'HH:mm:ss', countryCode: 33, countryName: 'France', languageAbbreviation: 'FRA' },
  { name: 'de-DE', lcid: 1031, displayName: 'German (Germany)', shortDate: 'dd.MM.yyyy', timeFormat: 'HH:mm:ss', countryCode: 49, countryName: 'Germany', languageAbbreviation: 'DEU' },
  { name: 'es-ES', lcid: 3082, displayName: 'Spanish (Spain)', shortDate: 'dd/MM/yyyy', timeFormat: 'H:mm:ss', countryCode: 34, countryName: 'Spain', languageAbbreviation: 'ESN' },
  { name: 'it-IT', lcid: 1040, displayName: 'Italian (Italy)', shortDate: 'dd/MM/yyyy', timeFormat: 'HH:mm:ss', countryCode: 39, countryName: 'Italy', languageAbbreviation: 'ITA' },
  { name: 'pt-BR', lcid: 1046, displayName: 'Portuguese (Brazil)', shortDate: 'dd/MM/yyyy', timeFormat: 'HH:mm:ss', countryCode: 55, countryName: 'Brazil', languageAbbreviation: 'PTB' },
  { name: 'nl-NL', lcid: 1043, displayName: 'Dutch (Netherlands)', shortDate: 'dd-MM-yyyy', timeFormat: 'HH:mm:ss', countryCode: 31, countryName: 'Netherlands', languageAbbreviation: 'NLD' },
  { name: 'ja-JP', lcid: 1041, displayName: 'Japanese (Japan)', shortDate: 'yyyy/MM/dd', timeFormat: 'H:mm:ss', countryCode: 81, countryName: 'Japan', languageAbbreviation: 'JPN' },
  { name: 'zh-CN', lcid: 2052, displayName: 'Chinese (Simplified, PRC)', shortDate: 'yyyy/M/d', timeFormat: 'H:mm:ss', countryCode: 86, countryName: "People's Republic of China", languageAbbreviation: 'CHS' },
];

export function findCulture(name: string): WindowsCulture | undefined {
  const lower = name.toLowerCase();
  return WINDOWS_CULTURES.find((culture) => culture.name.toLowerCase() === lower);
}

export function dateOrderOf(shortDatePattern: string): DateOrder {
  const first = (letter: string): number => {
    const index = shortDatePattern.toLowerCase().indexOf(letter);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const day = first('d');
  const month = first('m');
  const year = first('y');
  if (year < day && year < month) return 'YMD';
  return day < month ? 'DMY' : 'MDY';
}

export function cultureRegistryValues(culture: WindowsCulture): Record<string, string> {
  return {
    LocaleName: culture.name,
    sShortDate: culture.shortDate,
    sTimeFormat: culture.timeFormat,
    iDate: String(['MDY', 'DMY', 'YMD'].indexOf(dateOrderOf(culture.shortDate))),
    iCountry: String(culture.countryCode),
    sCountry: culture.countryName,
    sLanguage: culture.languageAbbreviation,
  };
}

export interface RegionalFormats {
  readonly shortDate: string;
  readonly timeFormat: string;
}

export const DEFAULT_REGIONAL_FORMATS: RegionalFormats = { shortDate: 'M/d/yyyy', timeFormat: 'h:mm:ss tt' };

export function regionalFormatsFrom(values: Record<string, string | number> | null): RegionalFormats {
  const shortDate = values?.sShortDate;
  const timeFormat = values?.sTimeFormat;
  return {
    shortDate: typeof shortDate === 'string' && shortDate !== '' ? shortDate : DEFAULT_REGIONAL_FORMATS.shortDate,
    timeFormat: typeof timeFormat === 'string' && timeFormat !== '' ? timeFormat : DEFAULT_REGIONAL_FORMATS.timeFormat,
  };
}
