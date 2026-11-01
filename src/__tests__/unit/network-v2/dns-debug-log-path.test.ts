/*
 * Structure — where the DNS server writes its debug log. The path of the file is read from LogFilePath: nothing gives the
 * default dns.log in the system32\\dns directory, a bare file name goes to the same directory, a relative path with a
 * directory is relative to the Windows directory (the examples of the Windows Server 2003 page "Using server debug logging
 * options": dns.log and temp\\dns.log), an absolute or UNC path is taken as written. Discrimination (run on the tree
 * before the change): every case falls, the resolver did not exist.
 */
import { describe, it, expect } from 'vitest';
import { resolveLogFilePath } from '@/network/devices/windows/server/dns/DnsDebugLog';

describe('where the debug log is written', () => {
  it('a bare file name goes to the dns directory, a relative path to the Windows directory, an absolute path stays', () => {
    expect(resolveLogFilePath('')).toBe('C:\\Windows\\System32\\dns\\dns.log');
    expect(resolveLogFilePath('queries.log')).toBe('C:\\Windows\\System32\\dns\\queries.log');
    expect(resolveLogFilePath('temp\\dns.log')).toBe('C:\\Windows\\temp\\dns.log');
    expect(resolveLogFilePath('temp/dns.log')).toBe('C:\\Windows\\temp\\dns.log');
    expect(resolveLogFilePath('D:\\logs\\dns.log')).toBe('D:\\logs\\dns.log');
    expect(resolveLogFilePath('\\\\share\\logs\\dns.log')).toBe('\\\\share\\logs\\dns.log');
  });

});
