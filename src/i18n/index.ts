import { DEVICE_CATALOG } from '@/network';
import type { DeviceType } from '@/network';
import {
  FRENCH_DEVICE_DESCRIPTIONS, FRENCH_DEVICE_LABELS, LOCALES, MESSAGES, type Locale, type MessageKey,
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
  if (announced !== null) return announced;
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    return DEFAULT_LOCALE;
  }
  return localeFromLanguageTag(globalThis.navigator?.language);
}

const listeners = new Set<() => void>();
let announced: Locale | null = null;

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    announced = locale;
  }
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = locale;
  for (const listener of [...listeners]) listener();
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

export function deviceTypeDescription(type: DeviceType, locale: Locale): string {
  return locale === 'fr' ? FRENCH_DEVICE_DESCRIPTIONS[type] : DEVICE_CATALOG[type].description;
}

export function categoryLabel(id: string, locale: Locale, fallback: string): string {
  const key = `category.${id}`;
  return key in MESSAGES.en ? translate(locale, key as MessageKey) : fallback;
}
