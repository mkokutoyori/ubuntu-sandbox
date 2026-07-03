export interface WinRmListener {
  transport: 'HTTP' | 'HTTPS';
  port: number;
}

export class WindowsWinRmConfig {
  enabled = false;
  listeners: WinRmListener[] = [];
  credSSP = false;

  enable(): void {
    this.enabled = true;
    if (!this.listeners.some(l => l.transport === 'HTTP')) {
      this.listeners.push({ transport: 'HTTP', port: 5985 });
    }
  }
}

/** `winrm enumerate winrm/config/listener` — cmd-level native command. */
export function cmdWinrm(config: WindowsWinRmConfig, args: string[]): string {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === 'enumerate') {
    const target = (args[1] ?? '').toLowerCase();
    if (target === 'winrm/config/listener') {
      if (config.listeners.length === 0) {
        return 'WSManFault\n    Message = No listeners were found that are compatible with the request.';
      }
      return config.listeners.map(l => [
        'Listener',
        '    Address = *',
        `    Transport = ${l.transport}`,
        `    Port = ${l.port}`,
        '    Hostname',
        '    Enabled = true',
        '    URLPrefix = wsman',
        '    CertificateThumbprint',
        '    ListeningOn = 0.0.0.0',
      ].join('\n')).join('\n\n');
    }
  }
  return 'WinRM command not recognized.';
}
