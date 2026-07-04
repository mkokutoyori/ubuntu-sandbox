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

/** `winrm quickconfig` / `winrm enumerate winrm/config/listener` — cmd-level native commands. */
export function cmdWinrm(config: WindowsWinRmConfig, args: string[]): string {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === 'quickconfig' || sub === 'qc') {
    if (config.enabled) {
      return 'WinRM service is already running on this machine.\nWinRM is already set up to receive requests on this machine.';
    }
    config.enable();
    return [
      'WinRM service is not running on this machine.',
      'WinRM service started.',
      'WinRM is not set up to allow remote access to this machine for management.',
      'The following changes must be made:',
      '',
      'Create a WinRM listener on HTTP://* to accept WS-Man requests to any IP on this machine.',
      '',
      'WinRM has been updated to receive requests.',
      'A listener has been created on this machine for the HTTP protocol using address * with port 5985.',
    ].join('\n');
  }
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
