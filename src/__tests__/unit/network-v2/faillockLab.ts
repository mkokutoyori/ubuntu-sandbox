const COMMON_AUTH_WITH_FAILLOCK = [
  'auth\trequired\t\t\tpam_faillock.so preauth',
  'auth\t[success=1 default=ignore]\tpam_unix.so nullok',
  'auth\t[default=die]\t\t\tpam_faillock.so authfail',
  'auth\tsufficient\t\t\tpam_faillock.so authsucc',
  'auth\trequisite\t\t\tpam_deny.so',
  'auth\trequired\t\t\tpam_permit.so',
  'auth\toptional\t\t\tpam_cap.so',
  '',
].join('\n');

const COMMON_ACCOUNT_WITH_FAILLOCK = [
  'account\t[success=1 new_authtok_reqd=done default=ignore]\tpam_unix.so ',
  'account\trequisite\t\t\tpam_deny.so',
  'account\trequired\t\t\tpam_permit.so',
  'account\trequired\t\t\tpam_faillock.so',
  '',
].join('\n');

interface DeviceWithVfs {
  executor: { vfs: { writeFile(path: string, content: string, uid: number, gid: number, umask: number): void } };
}

export function enableFaillock(device: unknown, conf: readonly string[] = ['deny = 3']): void {
  const { vfs } = (device as DeviceWithVfs).executor;
  vfs.writeFile('/etc/pam.d/common-auth', COMMON_AUTH_WITH_FAILLOCK, 0, 0, 0o022);
  vfs.writeFile('/etc/pam.d/common-account', COMMON_ACCOUNT_WITH_FAILLOCK, 0, 0, 0o022);
  vfs.writeFile('/etc/security/faillock.conf', `${conf.join('\n')}\n`, 0, 0, 0o022);
}
