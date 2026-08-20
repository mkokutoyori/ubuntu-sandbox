export function detectServiceFromBanner(
  banner: string,
): { service: string; version?: string } | null {
  if (banner.startsWith('SSH-')) {
    const versionMatch = /^(SSH-\d\.\d)-(\S+)/.exec(banner);
    return {
      service: 'ssh',
      version: versionMatch
        ? `${versionMatch[2]} (protocol ${versionMatch[1].slice(4)})`
        : undefined,
    };
  }
  if (banner.startsWith('220-') || banner.startsWith('220 ')) {
    if (/smtp|mail|esmtp/i.test(banner)) return { service: 'smtp' };
    return { service: 'ftp' };
  }
  if (banner.startsWith('HTTP/')) return { service: 'http' };
  if (banner.startsWith('* OK')) return { service: 'imap' };
  if (banner.startsWith('+OK')) return { service: 'pop3' };
  if (banner.startsWith('(CONNECT_DATA=')) return { service: 'oracle-tns' };
  return null;
}
