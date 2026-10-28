import type { ArgumentSpec } from '../../ArgumentTypes';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
];

export function clockTime(name: string, description: string, seconds = false): ArgumentSpec {
  return {
    name, type: 'WORD', literal: seconds ? 'hh:mm:ss' : 'hh:mm', description,
    pattern: seconds
      ? /^(?:[01]?\d|2[0-3]):[0-5]\d:[0-5]\d$/
      : /^(?:[01]?\d|2[0-3]):[0-5]\d$/,
  };
}

export function monthOrDay(name: string, description: string): ArgumentSpec {
  return {
    name, type: 'WORD', description,
    pattern: /^(?:[1-9]|[12]\d|3[01]|[A-Za-z]{3,9})$/,
    alternatives: [
      { keyword: '<1-31>', description: 'Day of the month' },
      ...MONTHS.map((keyword) => ({ keyword, description: 'Month' })),
    ],
    formsAreExhaustive: true,
  };
}
