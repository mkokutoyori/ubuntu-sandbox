import { describe, it, expect } from 'vitest';
import { serviceFromProcess } from '@/network/scan/nmap/ProcessServiceMap';

describe('serviceFromProcess', () => {
  it('mappe les daemons web vers http', () => {
    expect(serviceFromProcess('apache2')).toBe('http');
    expect(serviceFromProcess('nginx')).toBe('http');
  });

  it('mappe les bases de données', () => {
    expect(serviceFromProcess('mysqld')).toBe('mysql');
    expect(serviceFromProcess('postgres')).toBe('postgresql');
  });

  it('mappe le listener Oracle vers oracle-tns', () => {
    expect(serviceFromProcess('tnslsnr')).toBe('oracle-tns');
  });

  it('mappe sshd vers ssh', () => {
    expect(serviceFromProcess('sshd')).toBe('ssh');
  });

  it('mappe les résolveurs DNS vers domain', () => {
    expect(serviceFromProcess('systemd-resolved')).toBe('domain');
    expect(serviceFromProcess('named')).toBe('domain');
    expect(serviceFromProcess('dnsmasq')).toBe('domain');
  });

  it('retourne null pour un processus inconnu', () => {
    expect(serviceFromProcess('frobnicator')).toBeNull();
  });
});
