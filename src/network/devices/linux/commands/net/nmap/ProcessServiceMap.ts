const PROCESS_SERVICE: Record<string, string> = {
  sshd: 'ssh',
  'sshd.exe': 'ssh',
  apache2: 'http',
  httpd: 'http',
  nginx: 'http',
  mysqld: 'mysql',
  postgres: 'postgresql',
  tnslsnr: 'oracle-tns',
  'systemd-resolved': 'domain',
  named: 'domain',
  dnsmasq: 'domain',
};

export function serviceFromProcess(process: string): string | null {
  return PROCESS_SERVICE[process] ?? null;
}
