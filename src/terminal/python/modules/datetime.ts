/**
 * Python Datetime Module
 */

import { PyValue, PyModule, PyFunction, PyClass, PyInstance, pyInt, pyFloat, pyStr, pyBool, pyNone, pyTuple } from '../types';
import { TypeError, ValueError } from '../errors';

function func(name: string, fn: (...args: PyValue[]) => PyValue): PyFunction {
  return {
    type: 'function',
    name,
    params: [],
    body: [],
    closure: new Map(),
    isBuiltin: true,
    builtinFn: fn
  };
}

export function getDatetimeModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  // datetime class
  const datetimeClass: PyClass = {
    type: 'class',
    name: 'datetime',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  };

  // Helper to create datetime instance
  const createDatetime = (date: Date): PyInstance => {
    const instance: PyInstance = {
      type: 'instance',
      __class__: datetimeClass,
      attributes: new Map([
        ['year', pyInt(date.getFullYear())],
        ['month', pyInt(date.getMonth() + 1)],
        ['day', pyInt(date.getDate())],
        ['hour', pyInt(date.getHours())],
        ['minute', pyInt(date.getMinutes())],
        ['second', pyInt(date.getSeconds())],
        ['microsecond', pyInt(date.getMilliseconds() * 1000)],
        ['_date', { type: 'str', value: date.toISOString() } as any]
      ])
    };
    return instance;
  };

  // datetime.now()
  datetimeClass.methods.set('now', func('now', () => {
    return createDatetime(new Date());
  }));

  // datetime.today()
  datetimeClass.methods.set('today', func('today', () => {
    return createDatetime(new Date());
  }));

  // datetime.utcnow()
  datetimeClass.methods.set('utcnow', func('utcnow', () => {
    const now = new Date();
    const utc = new Date(now.getTime() + now.getTimezoneOffset() * 60000);
    return createDatetime(utc);
  }));

  // datetime.fromtimestamp()
  datetimeClass.methods.set('fromtimestamp', func('fromtimestamp', (timestamp: PyValue) => {
    if (timestamp.type !== 'int' && timestamp.type !== 'float') {
      throw new TypeError("an integer is required");
    }
    return createDatetime(new Date(timestamp.value * 1000));
  }));

  // datetime.strptime()
  datetimeClass.methods.set('strptime', func('strptime', (dateStr: PyValue, format: PyValue) => {
    if (dateStr.type !== 'str' || format.type !== 'str') {
      throw new TypeError("strptime() requires string arguments");
    }
    // Simplified parsing - just try to parse the string
    const date = new Date(dateStr.value);
    if (isNaN(date.getTime())) {
      throw new ValueError(`time data '${dateStr.value}' does not match format '${format.value}'`);
    }
    return createDatetime(date);
  }));

  // Instance methods (will be bound when accessed)
  datetimeClass.methods.set('strftime', func('strftime', function(this: PyInstance, format: PyValue) {
    if (format.type !== 'str') {
      throw new TypeError("strftime() requires string format");
    }

    const year = (this.attributes.get('year') as any).value;
    const month = (this.attributes.get('month') as any).value;
    const day = (this.attributes.get('day') as any).value;
    const hour = (this.attributes.get('hour') as any).value;
    const minute = (this.attributes.get('minute') as any).value;
    const second = (this.attributes.get('second') as any).value;

    let result = format.value;
    result = result.replace(/%Y/g, String(year));
    result = result.replace(/%m/g, String(month).padStart(2, '0'));
    result = result.replace(/%d/g, String(day).padStart(2, '0'));
    result = result.replace(/%H/g, String(hour).padStart(2, '0'));
    result = result.replace(/%M/g, String(minute).padStart(2, '0'));
    result = result.replace(/%S/g, String(second).padStart(2, '0'));
    result = result.replace(/%I/g, String(hour % 12 || 12).padStart(2, '0'));
    result = result.replace(/%p/g, hour < 12 ? 'AM' : 'PM');
    result = result.replace(/%y/g, String(year % 100).padStart(2, '0'));
    result = result.replace(/%B/g, ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'][month - 1]);
    result = result.replace(/%b/g, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]);
    result = result.replace(/%A/g, ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
      'Thursday', 'Friday', 'Saturday'][new Date(year, month - 1, day).getDay()]);
    result = result.replace(/%a/g, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      [new Date(year, month - 1, day).getDay()]);

    return pyStr(result);
  }));

  datetimeClass.methods.set('isoformat', func('isoformat', function(this: PyInstance) {
    const year = (this.attributes.get('year') as any).value;
    const month = (this.attributes.get('month') as any).value;
    const day = (this.attributes.get('day') as any).value;
    const hour = (this.attributes.get('hour') as any).value;
    const minute = (this.attributes.get('minute') as any).value;
    const second = (this.attributes.get('second') as any).value;

    return pyStr(
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T` +
      `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
    );
  }));

  datetimeClass.methods.set('timestamp', func('timestamp', function(this: PyInstance) {
    const year = (this.attributes.get('year') as any).value;
    const month = (this.attributes.get('month') as any).value;
    const day = (this.attributes.get('day') as any).value;
    const hour = (this.attributes.get('hour') as any).value;
    const minute = (this.attributes.get('minute') as any).value;
    const second = (this.attributes.get('second') as any).value;

    const date = new Date(year, month - 1, day, hour, minute, second);
    return pyFloat(date.getTime() / 1000);
  }));

  datetimeClass.methods.set('weekday', func('weekday', function(this: PyInstance) {
    const year = (this.attributes.get('year') as any).value;
    const month = (this.attributes.get('month') as any).value;
    const day = (this.attributes.get('day') as any).value;

    const date = new Date(year, month - 1, day);
    // Python: Monday = 0, Sunday = 6
    return pyInt((date.getDay() + 6) % 7);
  }));

  datetimeClass.methods.set('isoweekday', func('isoweekday', function(this: PyInstance) {
    const year = (this.attributes.get('year') as any).value;
    const month = (this.attributes.get('month') as any).value;
    const day = (this.attributes.get('day') as any).value;

    const date = new Date(year, month - 1, day);
    // ISO: Monday = 1, Sunday = 7
    return pyInt(date.getDay() || 7);
  }));

  exports.set('datetime', datetimeClass);

  // date class (simplified)
  const dateClass: PyClass = {
    type: 'class',
    name: 'date',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  };

  const createDate = (year: number, month: number, day: number): PyInstance => ({
    type: 'instance',
    __class__: dateClass,
    attributes: new Map([
      ['year', pyInt(year)],
      ['month', pyInt(month)],
      ['day', pyInt(day)]
    ])
  });

  dateClass.methods.set('today', func('today', () => {
    const now = new Date();
    return createDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }));

  dateClass.methods.set('fromtimestamp', func('fromtimestamp', (timestamp: PyValue) => {
    if (timestamp.type !== 'int' && timestamp.type !== 'float') {
      throw new TypeError("an integer is required");
    }
    const date = new Date(timestamp.value * 1000);
    return createDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }));

  exports.set('date', dateClass);

  // time class (simplified)
  const timeClass: PyClass = {
    type: 'class',
    name: 'time',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  };

  exports.set('time', timeClass);

  // timedelta class
  const timedeltaClass: PyClass = {
    type: 'class',
    name: 'timedelta',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  };

  const createTimedelta = (days: number = 0, seconds: number = 0, microseconds: number = 0): PyInstance => ({
    type: 'instance',
    __class__: timedeltaClass,
    attributes: new Map([
      ['days', pyInt(days)],
      ['seconds', pyInt(seconds)],
      ['microseconds', pyInt(microseconds)]
    ])
  });

  timedeltaClass.methods.set('total_seconds', func('total_seconds', function(this: PyInstance) {
    const days = (this.attributes.get('days') as any).value;
    const seconds = (this.attributes.get('seconds') as any).value;
    const microseconds = (this.attributes.get('microseconds') as any).value;
    return pyFloat(days * 86400 + seconds + microseconds / 1000000);
  }));

  exports.set('timedelta', timedeltaClass);

  // Constants
  exports.set('MINYEAR', pyInt(1));
  exports.set('MAXYEAR', pyInt(9999));

  return {
    type: 'module',
    name: 'datetime',
    exports
  };
}
