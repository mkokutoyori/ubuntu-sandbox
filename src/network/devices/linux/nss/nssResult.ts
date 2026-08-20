import type { NssEnumResult, NssResult } from './types';

export const nssOk = <T>(entry: T): NssResult<T> => ({ status: 'SUCCESS', entry });
export const nssNotFound = <T>(): NssResult<T> => ({ status: 'NOTFOUND' });
export const nssEnumOk = <T>(entries: T[]): NssEnumResult<T> => ({ status: 'SUCCESS', entries });
export const nssEnumEmpty = <T>(): NssEnumResult<T> => ({ status: 'NOTFOUND', entries: [] });
