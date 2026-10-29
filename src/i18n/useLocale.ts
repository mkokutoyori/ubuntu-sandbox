import { useCallback, useSyncExternalStore } from 'react';
import {
  getLocale, setLocale, subscribeLocale, translate, type Locale, type MessageKey,
} from './index';

export interface LocaleBinding {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey, variables?: Readonly<Record<string, string | number>>) => string;
}

export function useLocale(): LocaleBinding {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const t = useCallback(
    (key: MessageKey, variables?: Readonly<Record<string, string | number>>) =>
      translate(locale, key, variables),
    [locale],
  );
  return { locale, setLocale, t };
}
