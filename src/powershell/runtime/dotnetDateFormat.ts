export function formatDotNetDate(d: Date, fmt: string): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return fmt.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|tt/g, (tok) => {
    switch (tok) {
      case 'yyyy': return pad(d.getFullYear(), 4);
      case 'yy':   return pad(d.getFullYear() % 100, 2);
      case 'MMMM': return monthNames[d.getMonth()];
      case 'MMM':  return monthNames[d.getMonth()].slice(0, 3);
      case 'MM':   return pad(d.getMonth() + 1, 2);
      case 'M':    return String(d.getMonth() + 1);
      case 'dddd': return dayNames[d.getDay()];
      case 'ddd':  return dayNames[d.getDay()].slice(0, 3);
      case 'dd':   return pad(d.getDate(), 2);
      case 'd':    return String(d.getDate());
      case 'HH':   return pad(d.getHours(), 2);
      case 'H':    return String(d.getHours());
      case 'hh':   return pad(h12, 2);
      case 'h':    return String(h12);
      case 'mm':   return pad(d.getMinutes(), 2);
      case 'm':    return String(d.getMinutes());
      case 'ss':   return pad(d.getSeconds(), 2);
      case 's':    return String(d.getSeconds());
      case 'fff':  return pad(d.getMilliseconds(), 3);
      case 'tt':   return d.getHours() < 12 ? 'AM' : 'PM';
      default:     return tok;
    }
  });
}
