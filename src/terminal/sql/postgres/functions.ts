/**
 * PostgreSQL SQL Functions
 * Implementation of common PostgreSQL functions
 */

export type PostgresFunctionEvaluator = (args: any[]) => any;

/**
 * PostgreSQL built-in functions
 */
export const POSTGRES_FUNCTIONS: Record<string, PostgresFunctionEvaluator> = {
  // ============================================
  // String Functions
  // ============================================

  // Length functions
  'LENGTH': (args) => args[0] != null ? String(args[0]).length : null,
  'CHAR_LENGTH': (args) => args[0] != null ? String(args[0]).length : null,
  'CHARACTER_LENGTH': (args) => args[0] != null ? String(args[0]).length : null,
  'OCTET_LENGTH': (args) => args[0] != null ? new TextEncoder().encode(String(args[0])).length : null,
  'BIT_LENGTH': (args) => args[0] != null ? new TextEncoder().encode(String(args[0])).length * 8 : null,

  // Case functions
  'UPPER': (args) => args[0] != null ? String(args[0]).toUpperCase() : null,
  'LOWER': (args) => args[0] != null ? String(args[0]).toLowerCase() : null,
  'INITCAP': (args) => {
    if (args[0] == null) return null;
    return String(args[0]).replace(/\b\w/g, c => c.toUpperCase());
  },

  // Substring functions
  'SUBSTRING': (args) => {
    if (args[0] == null) return null;
    const str = String(args[0]);
    const start = (args[1] || 1) - 1;
    const len = args[2];
    return len !== undefined ? str.substr(start, len) : str.substr(start);
  },
  'SUBSTR': (args) => {
    if (args[0] == null) return null;
    const str = String(args[0]);
    const start = (args[1] || 1) - 1;
    const len = args[2];
    return len !== undefined ? str.substr(start, len) : str.substr(start);
  },
  'LEFT': (args) => args[0] != null ? String(args[0]).substring(0, args[1]) : null,
  'RIGHT': (args) => args[0] != null ? String(args[0]).slice(-args[1]) : null,

  // Position functions
  'POSITION': (args) => {
    if (args[0] == null || args[1] == null) return null;
    const idx = String(args[1]).indexOf(String(args[0]));
    return idx === -1 ? 0 : idx + 1;
  },
  'STRPOS': (args) => {
    if (args[0] == null || args[1] == null) return null;
    const idx = String(args[0]).indexOf(String(args[1]));
    return idx === -1 ? 0 : idx + 1;
  },

  // Trim functions
  'TRIM': (args) => args[0] != null ? String(args[0]).trim() : null,
  'LTRIM': (args) => {
    if (args[0] == null) return null;
    const chars = args[1] || ' ';
    let str = String(args[0]);
    while (str.length > 0 && chars.includes(str[0])) {
      str = str.substring(1);
    }
    return str;
  },
  'RTRIM': (args) => {
    if (args[0] == null) return null;
    const chars = args[1] || ' ';
    let str = String(args[0]);
    while (str.length > 0 && chars.includes(str[str.length - 1])) {
      str = str.slice(0, -1);
    }
    return str;
  },
  'BTRIM': (args) => {
    if (args[0] == null) return null;
    const chars = args[1] || ' ';
    let str = String(args[0]);
    while (str.length > 0 && chars.includes(str[0])) {
      str = str.substring(1);
    }
    while (str.length > 0 && chars.includes(str[str.length - 1])) {
      str = str.slice(0, -1);
    }
    return str;
  },

  // Padding functions
  'LPAD': (args) => {
    if (args[0] == null) return null;
    const str = String(args[0]);
    const len = args[1];
    const pad = args[2] || ' ';
    if (str.length >= len) return str;
    return (pad.repeat(len) + str).slice(-len);
  },
  'RPAD': (args) => {
    if (args[0] == null) return null;
    const str = String(args[0]);
    const len = args[1];
    const pad = args[2] || ' ';
    if (str.length >= len) return str;
    return (str + pad.repeat(len)).substring(0, len);
  },

  // Replace functions
  'REPLACE': (args) => {
    if (args[0] == null) return null;
    return String(args[0]).split(args[1] || '').join(args[2] || '');
  },
  'TRANSLATE': (args) => {
    if (args[0] == null) return null;
    let result = String(args[0]);
    const from = args[1] || '';
    const to = args[2] || '';
    for (let i = 0; i < from.length; i++) {
      result = result.split(from[i]).join(i < to.length ? to[i] : '');
    }
    return result;
  },
  'OVERLAY': (args) => {
    if (args[0] == null) return null;
    const str = String(args[0]);
    const replacement = String(args[1] || '');
    const start = (args[2] || 1) - 1;
    const len = args[3] !== undefined ? args[3] : replacement.length;
    return str.substring(0, start) + replacement + str.substring(start + len);
  },

  // Concatenation
  'CONCAT': (args) => args.filter(a => a != null).join(''),
  'CONCAT_WS': (args) => {
    const sep = args[0] || '';
    return args.slice(1).filter(a => a != null).join(sep);
  },
  '||': (args) => args.map(a => a ?? '').join(''),

  // Pattern matching
  'LIKE': (args) => {
    if (args[0] == null || args[1] == null) return null;
    const str = String(args[0]);
    const pattern = String(args[1])
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '.*')
      .replace(/_/g, '.');
    return new RegExp(`^${pattern}$`, 'i').test(str);
  },

  // Reverse
  'REVERSE': (args) => args[0] != null ? String(args[0]).split('').reverse().join('') : null,

  // Repeat
  'REPEAT': (args) => args[0] != null ? String(args[0]).repeat(args[1] || 0) : null,

  // Split
  'SPLIT_PART': (args) => {
    if (args[0] == null) return null;
    const parts = String(args[0]).split(args[1] || '');
    const idx = (args[2] || 1) - 1;
    return idx >= 0 && idx < parts.length ? parts[idx] : '';
  },
  'STRING_TO_ARRAY': (args) => {
    if (args[0] == null) return null;
    return String(args[0]).split(args[1] || ',');
  },
  'ARRAY_TO_STRING': (args) => {
    if (!Array.isArray(args[0])) return null;
    return args[0].join(args[1] || ',');
  },

  // Format
  'FORMAT': (args) => {
    if (args[0] == null) return null;
    let result = String(args[0]);
    for (let i = 1; i < args.length; i++) {
      result = result.replace(/%s|%I|%L/, String(args[i] ?? ''));
    }
    return result;
  },

  // Quote functions
  'QUOTE_IDENT': (args) => args[0] != null ? `"${String(args[0]).replace(/"/g, '""')}"` : null,
  'QUOTE_LITERAL': (args) => args[0] != null ? `'${String(args[0]).replace(/'/g, "''")}'` : null,
  'QUOTE_NULLABLE': (args) => args[0] != null ? `'${String(args[0]).replace(/'/g, "''")}'` : 'NULL',

  // ASCII/CHR
  'ASCII': (args) => args[0] != null ? String(args[0]).charCodeAt(0) : null,
  'CHR': (args) => args[0] != null ? String.fromCharCode(args[0]) : null,

  // MD5
  'MD5': (args) => {
    // Simplified MD5 simulation - returns a fake hash
    if (args[0] == null) return null;
    const str = String(args[0]);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
  },

  // ============================================
  // Numeric Functions
  // ============================================

  'ABS': (args) => args[0] != null ? Math.abs(args[0]) : null,
  'CEIL': (args) => args[0] != null ? Math.ceil(args[0]) : null,
  'CEILING': (args) => args[0] != null ? Math.ceil(args[0]) : null,
  'FLOOR': (args) => args[0] != null ? Math.floor(args[0]) : null,
  'ROUND': (args) => {
    if (args[0] == null) return null;
    const scale = args[1] || 0;
    const multiplier = Math.pow(10, scale);
    return Math.round(args[0] * multiplier) / multiplier;
  },
  'TRUNC': (args) => {
    if (args[0] == null) return null;
    const scale = args[1] || 0;
    const multiplier = Math.pow(10, scale);
    return Math.trunc(args[0] * multiplier) / multiplier;
  },
  'MOD': (args) => args[0] != null && args[1] != null ? args[0] % args[1] : null,
  'POWER': (args) => args[0] != null && args[1] != null ? Math.pow(args[0], args[1]) : null,
  'POW': (args) => args[0] != null && args[1] != null ? Math.pow(args[0], args[1]) : null,
  'SQRT': (args) => args[0] != null ? Math.sqrt(args[0]) : null,
  'CBRT': (args) => args[0] != null ? Math.cbrt(args[0]) : null,
  'EXP': (args) => args[0] != null ? Math.exp(args[0]) : null,
  'LN': (args) => args[0] != null ? Math.log(args[0]) : null,
  'LOG': (args) => {
    if (args.length === 1) return args[0] != null ? Math.log10(args[0]) : null;
    if (args[0] != null && args[1] != null) return Math.log(args[1]) / Math.log(args[0]);
    return null;
  },
  'LOG10': (args) => args[0] != null ? Math.log10(args[0]) : null,

  'SIGN': (args) => args[0] != null ? Math.sign(args[0]) : null,
  'PI': () => Math.PI,

  // Trigonometric functions
  'SIN': (args) => args[0] != null ? Math.sin(args[0]) : null,
  'COS': (args) => args[0] != null ? Math.cos(args[0]) : null,
  'TAN': (args) => args[0] != null ? Math.tan(args[0]) : null,
  'ASIN': (args) => args[0] != null ? Math.asin(args[0]) : null,
  'ACOS': (args) => args[0] != null ? Math.acos(args[0]) : null,
  'ATAN': (args) => args[0] != null ? Math.atan(args[0]) : null,
  'ATAN2': (args) => args[0] != null && args[1] != null ? Math.atan2(args[0], args[1]) : null,
  'DEGREES': (args) => args[0] != null ? args[0] * (180 / Math.PI) : null,
  'RADIANS': (args) => args[0] != null ? args[0] * (Math.PI / 180) : null,

  // Random
  'RANDOM': () => Math.random(),
  'SETSEED': (args) => { /* no-op in simulation */ return null; },

  // Width bucket
  'WIDTH_BUCKET': (args) => {
    if (args[0] == null || args[1] == null || args[2] == null || args[3] == null) return null;
    const val = args[0];
    const min = args[1];
    const max = args[2];
    const count = args[3];
    if (val < min) return 0;
    if (val >= max) return count + 1;
    return Math.floor(((val - min) / (max - min)) * count) + 1;
  },

  // Greatest/Least
  'GREATEST': (args) => {
    const valid = args.filter(a => a != null);
    return valid.length > 0 ? Math.max(...valid) : null;
  },
  'LEAST': (args) => {
    const valid = args.filter(a => a != null);
    return valid.length > 0 ? Math.min(...valid) : null;
  },

  // ============================================
  // Date/Time Functions
  // ============================================

  'NOW': () => new Date(),
  'CURRENT_TIMESTAMP': () => new Date(),
  'CURRENT_DATE': () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  },
  'CURRENT_TIME': () => new Date(),
  'LOCALTIME': () => new Date(),
  'LOCALTIMESTAMP': () => new Date(),
  'CLOCK_TIMESTAMP': () => new Date(),
  'STATEMENT_TIMESTAMP': () => new Date(),
  'TRANSACTION_TIMESTAMP': () => new Date(),
  'TIMEOFDAY': () => new Date().toString(),

  'AGE': (args) => {
    if (args[0] == null) return null;
    const d1 = new Date(args[0]);
    const d2 = args[1] ? new Date(args[1]) : new Date();
    const years = d2.getFullYear() - d1.getFullYear();
    const months = d2.getMonth() - d1.getMonth();
    const days = d2.getDate() - d1.getDate();
    return `${years} years ${months} mons ${days} days`;
  },

  'DATE_PART': (args) => {
    if (args[0] == null || args[1] == null) return null;
    const part = String(args[0]).toLowerCase();
    const d = new Date(args[1]);
    switch (part) {
      case 'year': return d.getFullYear();
      case 'month': return d.getMonth() + 1;
      case 'day': return d.getDate();
      case 'hour': return d.getHours();
      case 'minute': return d.getMinutes();
      case 'second': return d.getSeconds();
      case 'dow': case 'dayofweek': return d.getDay();
      case 'doy': case 'dayofyear':
        const start = new Date(d.getFullYear(), 0, 0);
        const diff = d.getTime() - start.getTime();
        return Math.floor(diff / (1000 * 60 * 60 * 24));
      case 'week':
        const firstDay = new Date(d.getFullYear(), 0, 1);
        return Math.ceil(((d.getTime() - firstDay.getTime()) / (1000 * 60 * 60 * 24) + firstDay.getDay() + 1) / 7);
      case 'quarter': return Math.floor(d.getMonth() / 3) + 1;
      case 'epoch': return Math.floor(d.getTime() / 1000);
      default: return null;
    }
  },
  'EXTRACT': (args) => POSTGRES_FUNCTIONS['DATE_PART'](args),

  'DATE_TRUNC': (args) => {
    if (args[0] == null || args[1] == null) return null;
    const part = String(args[0]).toLowerCase();
    const d = new Date(args[1]);
    switch (part) {
      case 'year': return new Date(d.getFullYear(), 0, 1);
      case 'quarter': return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
      case 'month': return new Date(d.getFullYear(), d.getMonth(), 1);
      case 'week':
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(d.getFullYear(), d.getMonth(), diff);
      case 'day': return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      case 'hour': return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours());
      case 'minute': return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
      default: return d;
    }
  },

  'TO_TIMESTAMP': (args) => {
    if (args[0] == null) return null;
    if (typeof args[0] === 'number') {
      return new Date(args[0] * 1000);
    }
    return new Date(args[0]);
  },
  'TO_DATE': (args) => {
    if (args[0] == null) return null;
    return new Date(args[0]);
  },
  'TO_CHAR': (args) => {
    if (args[0] == null) return null;
    const val = args[0];
    const fmt = args[1] || '';

    if (val instanceof Date) {
      let result = fmt;
      result = result.replace(/YYYY/gi, val.getFullYear().toString());
      result = result.replace(/YY/gi, val.getFullYear().toString().slice(-2));
      result = result.replace(/MM/g, (val.getMonth() + 1).toString().padStart(2, '0'));
      result = result.replace(/DD/gi, val.getDate().toString().padStart(2, '0'));
      result = result.replace(/HH24/gi, val.getHours().toString().padStart(2, '0'));
      result = result.replace(/HH12/gi, ((val.getHours() % 12) || 12).toString().padStart(2, '0'));
      result = result.replace(/HH/gi, val.getHours().toString().padStart(2, '0'));
      result = result.replace(/MI/gi, val.getMinutes().toString().padStart(2, '0'));
      result = result.replace(/SS/gi, val.getSeconds().toString().padStart(2, '0'));
      result = result.replace(/AM|PM/gi, val.getHours() >= 12 ? 'PM' : 'AM');
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      result = result.replace(/Day/gi, days[val.getDay()]);
      result = result.replace(/Dy/gi, days[val.getDay()].substring(0, 3));
      result = result.replace(/Month/gi, months[val.getMonth()]);
      result = result.replace(/Mon/gi, months[val.getMonth()].substring(0, 3));
      return result;
    }

    if (typeof val === 'number') {
      return val.toLocaleString();
    }

    return String(val);
  },
  'TO_NUMBER': (args) => {
    if (args[0] == null) return null;
    const num = parseFloat(String(args[0]).replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? null : num;
  },

  'MAKE_DATE': (args) => {
    if (args[0] == null || args[1] == null || args[2] == null) return null;
    return new Date(args[0], args[1] - 1, args[2]);
  },
  'MAKE_TIME': (args) => {
    if (args[0] == null || args[1] == null || args[2] == null) return null;
    const d = new Date();
    d.setHours(args[0], args[1], args[2]);
    return d;
  },
  'MAKE_TIMESTAMP': (args) => {
    if (args.length < 6) return null;
    return new Date(args[0], (args[1] || 1) - 1, args[2] || 1, args[3] || 0, args[4] || 0, args[5] || 0);
  },

  'ISFINITE': (args) => args[0] != null && isFinite(new Date(args[0]).getTime()),

  // ============================================
  // Conditional Functions
  // ============================================

  'COALESCE': (args) => {
    for (const arg of args) {
      if (arg != null) return arg;
    }
    return null;
  },
  'NULLIF': (args) => {
    if (args[0] === args[1]) return null;
    return args[0];
  },

  'CASE': (args) => {
    // Handled specially by the parser
    return args[args.length - 1];
  },

  // ============================================
  // Array Functions
  // ============================================

  'ARRAY_AGG': (args) => args,
  'ARRAY_LENGTH': (args) => {
    if (!Array.isArray(args[0])) return null;
    return args[0].length;
  },
  'ARRAY_LOWER': (args) => Array.isArray(args[0]) ? 1 : null,
  'ARRAY_UPPER': (args) => Array.isArray(args[0]) ? args[0].length : null,
  'ARRAY_DIMS': (args) => Array.isArray(args[0]) ? `[1:${args[0].length}]` : null,
  'ARRAY_NDIMS': (args) => Array.isArray(args[0]) ? 1 : null,
  'ARRAY_POSITION': (args) => {
    if (!Array.isArray(args[0])) return null;
    const idx = args[0].indexOf(args[1]);
    return idx === -1 ? null : idx + 1;
  },
  'ARRAY_POSITIONS': (args) => {
    if (!Array.isArray(args[0])) return null;
    const positions: number[] = [];
    args[0].forEach((item: any, idx: number) => {
      if (item === args[1]) positions.push(idx + 1);
    });
    return positions;
  },
  'ARRAY_PREPEND': (args) => Array.isArray(args[1]) ? [args[0], ...args[1]] : [args[0]],
  'ARRAY_APPEND': (args) => Array.isArray(args[0]) ? [...args[0], args[1]] : [args[1]],
  'ARRAY_CAT': (args) => {
    const arr1 = Array.isArray(args[0]) ? args[0] : [args[0]];
    const arr2 = Array.isArray(args[1]) ? args[1] : [args[1]];
    return [...arr1, ...arr2];
  },
  'ARRAY_REMOVE': (args) => {
    if (!Array.isArray(args[0])) return null;
    return args[0].filter((item: any) => item !== args[1]);
  },
  'ARRAY_REPLACE': (args) => {
    if (!Array.isArray(args[0])) return null;
    return args[0].map((item: any) => item === args[1] ? args[2] : item);
  },
  'UNNEST': (args) => Array.isArray(args[0]) ? args[0] : [args[0]],
  'CARDINALITY': (args) => Array.isArray(args[0]) ? args[0].length : null,

  // ============================================
  // JSON Functions
  // ============================================

  'JSON_BUILD_OBJECT': (args) => {
    const obj: Record<string, any> = {};
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] != null) {
        obj[String(args[i])] = args[i + 1];
      }
    }
    return obj;
  },
  'JSON_BUILD_ARRAY': (args) => args,
  'JSON_OBJECT': (args) => {
    if (Array.isArray(args[0]) && Array.isArray(args[1])) {
      const obj: Record<string, any> = {};
      for (let i = 0; i < args[0].length && i < args[1].length; i++) {
        obj[String(args[0][i])] = args[1][i];
      }
      return obj;
    }
    return POSTGRES_FUNCTIONS['JSON_BUILD_OBJECT'](args);
  },
  'ROW_TO_JSON': (args) => args[0],
  'TO_JSON': (args) => args[0],
  'TO_JSONB': (args) => args[0],
  'JSON_ARRAY_LENGTH': (args) => Array.isArray(args[0]) ? args[0].length : null,
  'JSONB_ARRAY_LENGTH': (args) => Array.isArray(args[0]) ? args[0].length : null,
  'JSON_TYPEOF': (args) => {
    if (args[0] == null) return 'null';
    if (Array.isArray(args[0])) return 'array';
    if (typeof args[0] === 'object') return 'object';
    if (typeof args[0] === 'number') return 'number';
    if (typeof args[0] === 'boolean') return 'boolean';
    return 'string';
  },
  'JSONB_TYPEOF': (args) => POSTGRES_FUNCTIONS['JSON_TYPEOF'](args),
  'JSON_EXTRACT_PATH': (args) => {
    if (args[0] == null) return null;
    let result = args[0];
    for (let i = 1; i < args.length; i++) {
      if (result == null) return null;
      result = result[args[i]];
    }
    return result;
  },
  'JSONB_EXTRACT_PATH': (args) => POSTGRES_FUNCTIONS['JSON_EXTRACT_PATH'](args),
  'JSON_EXTRACT_PATH_TEXT': (args) => {
    const result = POSTGRES_FUNCTIONS['JSON_EXTRACT_PATH'](args);
    return result != null ? String(result) : null;
  },
  'JSONB_EXTRACT_PATH_TEXT': (args) => POSTGRES_FUNCTIONS['JSON_EXTRACT_PATH_TEXT'](args),

  // ============================================
  // Aggregate Functions
  // ============================================

  'COUNT': (args) => args.length,
  'SUM': (args) => args.filter((a: any) => a != null).reduce((acc: number, val: any) => acc + Number(val), 0),
  'AVG': (args) => {
    const valid = args.filter((a: any) => a != null);
    if (valid.length === 0) return null;
    return valid.reduce((acc: number, val: any) => acc + Number(val), 0) / valid.length;
  },
  'MIN': (args) => {
    const valid = args.filter((a: any) => a != null);
    return valid.length > 0 ? Math.min(...valid) : null;
  },
  'MAX': (args) => {
    const valid = args.filter((a: any) => a != null);
    return valid.length > 0 ? Math.max(...valid) : null;
  },
  'STRING_AGG': (args) => {
    if (!Array.isArray(args[0])) return args[0];
    return args[0].filter((a: any) => a != null).join(args[1] || ',');
  },
  'BOOL_AND': (args) => args.every((a: any) => a === true),
  'BOOL_OR': (args) => args.some((a: any) => a === true),
  'EVERY': (args) => args.every((a: any) => a === true),

  // ============================================
  // System Information Functions
  // ============================================

  'CURRENT_DATABASE': () => 'postgres',
  'CURRENT_SCHEMA': () => 'public',
  'CURRENT_SCHEMAS': (args) => args[0] ? ['pg_catalog', 'public'] : ['public'],
  'CURRENT_USER': () => 'postgres',
  'SESSION_USER': () => 'postgres',
  'USER': () => 'postgres',
  'INET_CLIENT_ADDR': () => '127.0.0.1',
  'INET_CLIENT_PORT': () => 49152,
  'INET_SERVER_ADDR': () => '127.0.0.1',
  'INET_SERVER_PORT': () => 5432,
  'PG_BACKEND_PID': () => Math.floor(Math.random() * 10000) + 1000,
  'PG_POSTMASTER_START_TIME': () => new Date(Date.now() - 86400000),
  'VERSION': () => 'PostgreSQL 14.7 (Ubuntu 14.7-0ubuntu0.22.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 11.3.0-1ubuntu1~22.04) 11.3.0, 64-bit',

  // ============================================
  // Type Casting Functions
  // ============================================

  'CAST': (args) => args[0],
  '::': (args) => args[0],

  // Boolean
  'BOOL': (args) => {
    if (args[0] == null) return null;
    if (typeof args[0] === 'boolean') return args[0];
    const s = String(args[0]).toLowerCase();
    return s === 'true' || s === 't' || s === 'yes' || s === 'y' || s === '1' || s === 'on';
  },

  // Integer
  'INT': (args) => args[0] != null ? parseInt(String(args[0])) : null,
  'INT4': (args) => args[0] != null ? parseInt(String(args[0])) : null,
  'INT8': (args) => args[0] != null ? parseInt(String(args[0])) : null,
  'BIGINT': (args) => args[0] != null ? parseInt(String(args[0])) : null,

  // Float
  'FLOAT4': (args) => args[0] != null ? parseFloat(String(args[0])) : null,
  'FLOAT8': (args) => args[0] != null ? parseFloat(String(args[0])) : null,

  // Text
  'TEXT': (args) => args[0] != null ? String(args[0]) : null,

  // ============================================
  // Miscellaneous Functions
  // ============================================

  'GENERATE_SERIES': (args) => {
    if (args[0] == null || args[1] == null) return [];
    const start = Number(args[0]);
    const end = Number(args[1]);
    const step = args[2] != null ? Number(args[2]) : 1;
    const result: number[] = [];
    if (step > 0) {
      for (let i = start; i <= end; i += step) result.push(i);
    } else if (step < 0) {
      for (let i = start; i >= end; i += step) result.push(i);
    }
    return result;
  },

  'GEN_RANDOM_UUID': () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },
  'UUID_GENERATE_V4': () => POSTGRES_FUNCTIONS['GEN_RANDOM_UUID']([]),

  'PG_SLEEP': (args) => {
    // Can't actually sleep in simulation, return immediately
    return null;
  },
  'PG_SLEEP_FOR': (args) => null,
  'PG_SLEEP_UNTIL': (args) => null,

  'SETVAL': (args) => args[1],
  'NEXTVAL': (args) => Math.floor(Math.random() * 1000) + 1,
  'CURRVAL': (args) => Math.floor(Math.random() * 1000),
  'LASTVAL': () => Math.floor(Math.random() * 1000),
};

/**
 * Get a PostgreSQL function by name
 */
export function getPostgresFunction(name: string): PostgresFunctionEvaluator | undefined {
  return POSTGRES_FUNCTIONS[name.toUpperCase()];
}

/**
 * Check if a function name is a PostgreSQL function
 */
export function isPostgresFunction(name: string): boolean {
  return name.toUpperCase() in POSTGRES_FUNCTIONS;
}
