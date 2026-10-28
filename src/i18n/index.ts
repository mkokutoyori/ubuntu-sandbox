import { DEVICE_CATALOG } from '@/network';
import type { DeviceType } from '@/network';
import {
  FRENCH_DEVICE_LABELS, LOCALES, MESSAGES, type Locale, type MessageKey,
} from './messages';

export { LOCALES, LOCALE_NAMES, type Locale, type MessageKey } from './messages';

const STORAGE_KEY = 'ubuntu-sandbox.locale';
const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function localeFromLanguageTag(tag: string | undefined): Locale {
  const primary = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    return DEFAULT_LOCALE;
  }
  return localeFromLanguageTag(globalThis.navigator?.language);
}

export function setLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    return;
  }
}

export function translate(
  locale: Locale, key: MessageKey, variables: Readonly<Record<string, string | number>> = {},
): string {
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in variables ? String(variables[name]) : whole);
}

export function deviceTypeLabel(type: DeviceType, locale: Locale): string {
  return locale === 'fr' ? FRENCH_DEVICE_LABELS[type] : DEVICE_CATALOG[type].label;
}
