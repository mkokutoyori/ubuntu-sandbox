/*
 * English and French stay in step.
 *
 * The application must be usable in both languages, so the French catalog
 * is typed against the English keys (a missing key does not compile) and
 * this suite checks what the compiler cannot: no entry is empty, the
 * `{placeholders}` of a message are the same in both languages, every
 * equipment type has a French label different from nothing, and the locale
 * is picked from the browser language tag.
 */
import { describe, it, expect } from 'vitest';
import { DEVICE_CATALOG } from '@/network';
import type { DeviceType } from '@/network';
import { MESSAGES, FRENCH_DEVICE_LABELS } from '@/i18n/messages';
import { deviceTypeLabel, localeFromLanguageTag, translate } from '@/i18n';

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('message catalogs', () => {
  const keys = Object.keys(MESSAGES.en);

  it('French has exactly the English keys', () => {
    expect(Object.keys(MESSAGES.fr).sort()).toEqual([...keys].sort());
  });

  it('no message is empty', () => {
    for (const locale of ['en', 'fr'] as const) {
      for (const key of keys) {
        expect((MESSAGES[locale] as Record<string, string>)[key].trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('placeholders agree between the two languages', () => {
    for (const key of keys) {
      expect(placeholders((MESSAGES.fr as Record<string, string>)[key]), key)
        .toEqual(placeholders((MESSAGES.en as Record<string, string>)[key]));
    }
  });

  it('witness: translate substitutes variables and leaves unknown ones visible', () => {
    expect(translate('fr', 'legend.count', { count: 3 })).toBe('3 sur le schéma');
    expect(translate('en', 'legend.count')).toContain('{count}');
  });
});

describe('equipment labels', () => {
  const types = Object.keys(DEVICE_CATALOG) as DeviceType[];

  it('every type has a label in both languages', () => {
    for (const type of types) {
      expect(deviceTypeLabel(type, 'en'), type).toBe(DEVICE_CATALOG[type].label);
      expect(deviceTypeLabel(type, 'fr').length, type).toBeGreaterThan(0);
    }
    expect(Object.keys(FRENCH_DEVICE_LABELS).sort()).toEqual([...types].sort());
  });
});

describe('locale selection', () => {
  it('reads the primary subtag of the browser language', () => {
    expect(localeFromLanguageTag('fr-CM')).toBe('fr');
    expect(localeFromLanguageTag('fr')).toBe('fr');
    expect(localeFromLanguageTag('en-GB')).toBe('en');
    expect(localeFromLanguageTag('de-DE')).toBe('en');
    expect(localeFromLanguageTag(undefined)).toBe('en');
  });
});
