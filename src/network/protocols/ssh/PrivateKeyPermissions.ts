export function unprotectedPrivateKeyWarning(path: string, mode: number): readonly string[] | null {
  if ((mode & 0o077) === 0) return null;
  return [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    `Permissions 0${(mode & 0o777).toString(8).padStart(3, '0')} for '${path}' are too open.`,
    'It is required that your private key files are NOT accessible by others.',
    'This private key will be ignored.',
  ];
}
