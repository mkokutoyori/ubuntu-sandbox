/**
 * Oracle SQL Functions - Oracle-specific SQL functions
 */

import { SQLValue, SQLRow, SQLExpression } from '../generic/types';

// Oracle function evaluator interface
export type OracleFunctionEvaluator = (args: SQLValue[], row?: SQLRow) => SQLValue;

/**
 * Oracle-specific SQL functions
 */
export const ORACLE_FUNCTIONS: Record<string, OracleFunctionEvaluator> = {
  // NULL-handling functions
  NVL: (args) => {
    return args[0] !== null && args[0] !== undefined ? args[0] : args[1];
  },

  NVL2: (args) => {
    return args[0] !== null && args[0] !== undefined ? args[1] : args[2];
  },

  NULLIF: (args) => {
    return args[0] === args[1] ? null : args[0];
  },

  COALESCE: (args) => {
    for (const arg of args) {
      if (arg !== null && arg !== undefined) return arg;
    }
    return null;
  },

  DECODE: (args) => {
    const expr = args[0];
    for (let i = 1; i < args.length - 1; i += 2) {
      if (expr === args[i]) {
        return args[i + 1];
      }
    }
    // Return default if odd number of args after expr
    if ((args.length - 1) % 2 === 1) {
      return args[args.length - 1];
    }
    return null;
  },

  // String functions
  CONCAT: (args) => {
    if (args[0] === null || args[1] === null) return null;
    return String(args[0]) + String(args[1]);
  },

  SUBSTR: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const start = Math.max(0, (args[1] as number) - 1);
    const len = args[2] as number | undefined;
    return len !== undefined ? str.substring(start, start + len) : str.substring(start);
  },

  INSTR: (args) => {
    if (args[0] === null || args[1] === null) return null;
    const str = String(args[0]);
    const search = String(args[1]);
    const start = ((args[2] as number) || 1) - 1;
    const occurrence = (args[3] as number) || 1;

    let pos = start;
    let found = 0;
    while (pos < str.length) {
      const idx = str.indexOf(search, pos);
      if (idx === -1) return 0;
      found++;
      if (found === occurrence) return idx + 1;
      pos = idx + 1;
    }
    return 0;
  },

  LENGTH: (args) => {
    if (args[0] === null) return null;
    return String(args[0]).length;
  },

  LENGTHB: (args) => {
    if (args[0] === null) return null;
    return Buffer.byteLength(String(args[0]), 'utf8');
  },

  UPPER: (args) => {
    if (args[0] === null) return null;
    return String(args[0]).toUpperCase();
  },

  LOWER: (args) => {
    if (args[0] === null) return null;
    return String(args[0]).toLowerCase();
  },

  INITCAP: (args) => {
    if (args[0] === null) return null;
    return String(args[0]).replace(/\b\w/g, c => c.toUpperCase());
  },

  TRIM: (args) => {
    if (args[0] === null) return null;
    return String(args[0]).trim();
  },

  LTRIM: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const chars = args[1] ? String(args[1]) : ' ';
    let i = 0;
    while (i < str.length && chars.includes(str[i])) i++;
    return str.substring(i);
  },

  RTRIM: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const chars = args[1] ? String(args[1]) : ' ';
    let i = str.length - 1;
    while (i >= 0 && chars.includes(str[i])) i--;
    return str.substring(0, i + 1);
  },

  LPAD: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const len = args[1] as number;
    const pad = args[2] ? String(args[2]) : ' ';
    if (str.length >= len) return str.substring(0, len);
    return (pad.repeat(Math.ceil((len - str.length) / pad.length)) + str).slice(-len);
  },

  RPAD: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const len = args[1] as number;
    const pad = args[2] ? String(args[2]) : ' ';
    if (str.length >= len) return str.substring(0, len);
    return (str + pad.repeat(Math.ceil((len - str.length) / pad.length))).substring(0, len);
  },

  REPLACE: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const search = String(args[1] || '');
    const replace = args[2] !== undefined ? String(args[2]) : '';
    return str.split(search).join(replace);
  },

  TRANSLATE: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    const from = String(args[1] || '');
    const to = String(args[2] || '');
    let result = '';
    for (const char of str) {
      const idx = from.indexOf(char);
      if (idx === -1) {
        result += char;
      } else if (idx < to.length) {
        result += to[idx];
      }
      // If idx >= to.length, character is removed
    }
    return result;
  },

  REVERSE: (args) => {
    if (args[0] === null) return null;
    return String(args[0]).split('').reverse().join('');
  },

  ASCII: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]);
    return str.length > 0 ? str.charCodeAt(0) : null;
  },

  CHR: (args) => {
    if (args[0] === null) return null;
    return String.fromCharCode(args[0] as number);
  },

  SOUNDEX: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]).toUpperCase();
    if (str.length === 0) return null;

    const codes: Record<string, string> = {
      B: '1', F: '1', P: '1', V: '1',
      C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
      D: '3', T: '3',
      L: '4',
      M: '5', N: '5',
      R: '6'
    };

    let result = str[0];
    let prev = codes[str[0]] || '0';

    for (let i = 1; i < str.length && result.length < 4; i++) {
      const code = codes[str[i]];
      if (code && code !== prev) {
        result += code;
      }
      if (code) prev = code;
    }

    return result.padEnd(4, '0');
  },

  // Numeric functions
  ABS: (args) => {
    if (args[0] === null) return null;
    return Math.abs(args[0] as number);
  },

  SIGN: (args) => {
    if (args[0] === null) return null;
    const n = args[0] as number;
    return n > 0 ? 1 : n < 0 ? -1 : 0;
  },

  CEIL: (args) => {
    if (args[0] === null) return null;
    return Math.ceil(args[0] as number);
  },

  FLOOR: (args) => {
    if (args[0] === null) return null;
    return Math.floor(args[0] as number);
  },

  ROUND: (args) => {
    if (args[0] === null) return null;
    const n = args[0] as number;
    const decimals = (args[1] as number) || 0;
    const factor = Math.pow(10, decimals);
    return Math.round(n * factor) / factor;
  },

  TRUNC: (args) => {
    if (args[0] === null) return null;
    const n = args[0] as number;
    const decimals = (args[1] as number) || 0;
    const factor = Math.pow(10, decimals);
    return Math.trunc(n * factor) / factor;
  },

  MOD: (args) => {
    if (args[0] === null || args[1] === null) return null;
    return (args[0] as number) % (args[1] as number);
  },

  POWER: (args) => {
    if (args[0] === null || args[1] === null) return null;
    return Math.pow(args[0] as number, args[1] as number);
  },

  SQRT: (args) => {
    if (args[0] === null) return null;
    return Math.sqrt(args[0] as number);
  },

  EXP: (args) => {
    if (args[0] === null) return null;
    return Math.exp(args[0] as number);
  },

  LN: (args) => {
    if (args[0] === null) return null;
    return Math.log(args[0] as number);
  },

  LOG: (args) => {
    if (args[0] === null || args[1] === null) return null;
    return Math.log(args[1] as number) / Math.log(args[0] as number);
  },

  SIN: (args) => {
    if (args[0] === null) return null;
    return Math.sin(args[0] as number);
  },

  COS: (args) => {
    if (args[0] === null) return null;
    return Math.cos(args[0] as number);
  },

  TAN: (args) => {
    if (args[0] === null) return null;
    return Math.tan(args[0] as number);
  },

  SINH: (args) => {
    if (args[0] === null) return null;
    return Math.sinh(args[0] as number);
  },

  COSH: (args) => {
    if (args[0] === null) return null;
    return Math.cosh(args[0] as number);
  },

  TANH: (args) => {
    if (args[0] === null) return null;
    return Math.tanh(args[0] as number);
  },

  ASIN: (args) => {
    if (args[0] === null) return null;
    return Math.asin(args[0] as number);
  },

  ACOS: (args) => {
    if (args[0] === null) return null;
    return Math.acos(args[0] as number);
  },

  ATAN: (args) => {
    if (args[0] === null) return null;
    return Math.atan(args[0] as number);
  },

  ATAN2: (args) => {
    if (args[0] === null || args[1] === null) return null;
    return Math.atan2(args[0] as number, args[1] as number);
  },

  GREATEST: (args) => {
    const nonNull = args.filter(a => a !== null);
    if (nonNull.length === 0) return null;
    return nonNull.reduce((max, val) => (val as number) > (max as number) ? val : max);
  },

  LEAST: (args) => {
    const nonNull = args.filter(a => a !== null);
    if (nonNull.length === 0) return null;
    return nonNull.reduce((min, val) => (val as number) < (min as number) ? val : min);
  },

  // Date functions
  SYSDATE: () => new Date(),

  SYSTIMESTAMP: () => new Date(),

  CURRENT_DATE: () => new Date(),

  CURRENT_TIMESTAMP: () => new Date(),

  ADD_MONTHS: (args) => {
    if (args[0] === null) return null;
    const date = args[0] instanceof Date ? args[0] : new Date(String(args[0]));
    const months = args[1] as number;
    const result = new Date(date);
    result.setMonth(result.getMonth() + months);
    return result;
  },

  MONTHS_BETWEEN: (args) => {
    if (args[0] === null || args[1] === null) return null;
    const date1 = args[0] instanceof Date ? args[0] : new Date(String(args[0]));
    const date2 = args[1] instanceof Date ? args[1] : new Date(String(args[1]));
    return (date1.getFullYear() - date2.getFullYear()) * 12 +
           (date1.getMonth() - date2.getMonth()) +
           (date1.getDate() - date2.getDate()) / 31;
  },

  LAST_DAY: (args) => {
    if (args[0] === null) return null;
    const date = args[0] instanceof Date ? args[0] : new Date(String(args[0]));
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
  },

  NEXT_DAY: (args) => {
    if (args[0] === null) return null;
    const date = args[0] instanceof Date ? args[0] : new Date(String(args[0]));
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const targetDay = dayNames.indexOf(String(args[1]).toUpperCase());
    if (targetDay === -1) return null;
    const result = new Date(date);
    const currentDay = result.getDay();
    const daysToAdd = (targetDay - currentDay + 7) % 7 || 7;
    result.setDate(result.getDate() + daysToAdd);
    return result;
  },

  EXTRACT: (args) => {
    // EXTRACT(field FROM date) - args[0] is field name, args[1] is date
    if (args[1] === null) return null;
    const date = args[1] instanceof Date ? args[1] : new Date(String(args[1]));
    const field = String(args[0]).toUpperCase();

    switch (field) {
      case 'YEAR': return date.getFullYear();
      case 'MONTH': return date.getMonth() + 1;
      case 'DAY': return date.getDate();
      case 'HOUR': return date.getHours();
      case 'MINUTE': return date.getMinutes();
      case 'SECOND': return date.getSeconds();
      default: return null;
    }
  },

  TO_DATE: (args) => {
    if (args[0] === null) return null;
    // Simplified - just parse the date string
    return new Date(String(args[0]));
  },

  TO_CHAR: (args) => {
    if (args[0] === null) return null;

    if (args[0] instanceof Date) {
      const date = args[0];
      const format = args[1] ? String(args[1]) : 'DD-MON-RR';
      return formatOracleDate(date, format);
    }

    // Number formatting
    if (typeof args[0] === 'number') {
      const num = args[0];
      const format = args[1] ? String(args[1]) : '';
      return formatOracleNumber(num, format);
    }

    return String(args[0]);
  },

  TO_NUMBER: (args) => {
    if (args[0] === null) return null;
    const str = String(args[0]).replace(/[,$]/g, '');
    const num = parseFloat(str);
    return isNaN(num) ? null : num;
  },

  TO_TIMESTAMP: (args) => {
    if (args[0] === null) return null;
    return new Date(String(args[0]));
  },

  // Conversion functions
  CAST: (args) => {
    // CAST(expr AS type) - simplified
    return args[0];
  },

  TO_CLOB: (args) => {
    if (args[0] === null) return null;
    return String(args[0]);
  },

  TO_BLOB: (args) => {
    if (args[0] === null) return null;
    return Buffer.from(String(args[0]));
  },

  HEXTORAW: (args) => {
    if (args[0] === null) return null;
    return Buffer.from(String(args[0]), 'hex');
  },

  RAWTOHEX: (args) => {
    if (args[0] === null) return null;
    if (Buffer.isBuffer(args[0])) {
      return args[0].toString('hex').toUpperCase();
    }
    return Buffer.from(String(args[0])).toString('hex').toUpperCase();
  },

  // Aggregate functions (these return single value for scalar context)
  COUNT: (args) => args[0] !== null ? 1 : 0,
  SUM: (args) => args[0],
  AVG: (args) => args[0],
  MIN: (args) => args[0],
  MAX: (args) => args[0],
  STDDEV: (args) => args[0],
  VARIANCE: (args) => args[0],

  // Analytic functions (simplified)
  ROW_NUMBER: () => 1,
  RANK: () => 1,
  DENSE_RANK: () => 1,
  NTILE: () => 1,
  LAG: (args) => args[0],
  LEAD: (args) => args[0],
  FIRST_VALUE: (args) => args[0],
  LAST_VALUE: (args) => args[0],

  // Miscellaneous
  ROWNUM: (args, row) => row ? (row['ROWNUM'] as number) || 1 : 1,

  ROWID: () => generateRowId(),

  SYS_GUID: () => generateGuid(),

  USER: () => 'SYSTEM',

  SYS_CONTEXT: (args) => {
    const namespace = String(args[0]).toUpperCase();
    const parameter = String(args[1]).toUpperCase();

    if (namespace === 'USERENV') {
      switch (parameter) {
        case 'CURRENT_USER': return 'SYSTEM';
        case 'SESSION_USER': return 'SYSTEM';
        case 'CURRENT_SCHEMA': return 'SYSTEM';
        case 'DB_NAME': return 'ORCL';
        case 'HOST': return 'localhost';
        case 'INSTANCE': return 1;
        case 'IP_ADDRESS': return '127.0.0.1';
        case 'LANGUAGE': return 'AMERICAN_AMERICA.AL32UTF8';
        case 'NLS_CALENDAR': return 'GREGORIAN';
        case 'NLS_CURRENCY': return '$';
        case 'NLS_DATE_FORMAT': return 'DD-MON-RR';
        case 'NLS_DATE_LANGUAGE': return 'AMERICAN';
        case 'NLS_SORT': return 'BINARY';
        case 'NLS_TERRITORY': return 'AMERICA';
        case 'OS_USER': return 'oracle';
        case 'SERVER_HOST': return 'localhost';
        case 'TERMINAL': return 'pts/0';
        default: return null;
      }
    }
    return null;
  },

  USERENV: (args) => {
    const parameter = String(args[0]).toUpperCase();
    switch (parameter) {
      case 'TERMINAL': return 'pts/0';
      case 'LANGUAGE': return 'AMERICAN_AMERICA.AL32UTF8';
      case 'SESSIONID': return 1;
      case 'ENTRYID': return 0;
      case 'LANG': return 'US';
      case 'INSTANCE': return 1;
      default: return null;
    }
  },

  UID: () => 0,

  DUMP: (args) => {
    if (args[0] === null) return 'NULL';
    const val = args[0];
    if (typeof val === 'string') {
      const bytes = Buffer.from(val);
      return `Typ=1 Len=${bytes.length}: ${Array.from(bytes).join(',')}`;
    }
    return `Typ=2 Len=1: ${val}`;
  },

  VSIZE: (args) => {
    if (args[0] === null) return null;
    if (typeof args[0] === 'string') {
      return Buffer.byteLength(args[0], 'utf8');
    }
    return 22; // Oracle NUMBER size
  },
};

// Helper functions
function formatOracleDate(date: Date, format: string): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const fullMonths = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const fullDays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

  const pad = (n: number, len: number = 2) => String(n).padStart(len, '0');

  let result = format.toUpperCase();

  // Year
  result = result.replace(/YYYY/g, String(date.getFullYear()));
  result = result.replace(/YY/g, String(date.getFullYear()).slice(-2));
  result = result.replace(/RR/g, String(date.getFullYear()).slice(-2));

  // Month
  result = result.replace(/MONTH/g, fullMonths[date.getMonth()]);
  result = result.replace(/MON/g, months[date.getMonth()]);
  result = result.replace(/MM/g, pad(date.getMonth() + 1));

  // Day
  result = result.replace(/DAY/g, fullDays[date.getDay()]);
  result = result.replace(/DY/g, days[date.getDay()]);
  result = result.replace(/DD/g, pad(date.getDate()));
  result = result.replace(/D/g, String(date.getDay() + 1));

  // Time
  result = result.replace(/HH24/g, pad(date.getHours()));
  result = result.replace(/HH12/g, pad(date.getHours() % 12 || 12));
  result = result.replace(/HH/g, pad(date.getHours()));
  result = result.replace(/MI/g, pad(date.getMinutes()));
  result = result.replace(/SS/g, pad(date.getSeconds()));

  // AM/PM
  const ampm = date.getHours() < 12 ? 'AM' : 'PM';
  result = result.replace(/AM|PM/g, ampm);
  result = result.replace(/A\.M\.|P\.M\./g, ampm[0] + '.' + ampm[1] + '.');

  return result;
}

function formatOracleNumber(num: number, format: string): string {
  if (!format) return String(num);

  // Count digits in format
  const intDigits = (format.match(/9/g) || []).length;
  const decMatch = format.match(/\.(\d*)/);
  const decDigits = decMatch ? decMatch[1].length : 0;

  let result = num.toFixed(decDigits);

  // Handle currency
  if (format.includes('$')) {
    result = '$' + result;
  }
  if (format.includes('L')) {
    result = '$' + result;
  }

  // Handle thousands separator
  if (format.includes(',')) {
    const parts = result.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    result = parts.join('.');
  }

  return result;
}

function generateRowId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < 18; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function generateGuid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16).toUpperCase();
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += hex();
  }
  return result;
}

/**
 * Get an Oracle function by name
 */
export function getOracleFunction(name: string): OracleFunctionEvaluator | null {
  return ORACLE_FUNCTIONS[name.toUpperCase()] || null;
}

/**
 * Check if a function name is an Oracle function
 */
export function isOracleFunction(name: string): boolean {
  return name.toUpperCase() in ORACLE_FUNCTIONS;
}

/**
 * Get list of all Oracle function names
 */
export function getOracleFunctionNames(): string[] {
  return Object.keys(ORACLE_FUNCTIONS);
}
