import {
  huaweiIrreversibleCipher, huaweiCipher, looksLikeIrreversibleCipher, looksLikeReversibleCipher,
} from '@/crypto/passwords/huawei';
import {
  NetworkOsAccount, type AccountServiceType, type PasswordHashAlgorithm,
} from '../../router/aaa/NetworkOsAccount';
import type { NetworkOsCredentialStore } from '../../router/aaa/NetworkOsCredentialStore';
import type { HuaweiPasswordPolicy } from '../../router/aaa/HuaweiAaaService';

export function applyVrpLocalUser(
  store: NetworkOsCredentialStore, args: readonly string[], policy: HuaweiPasswordPolicy,
): string {
  const name = args[0];
  if (!name || args.length < 2) return 'Error: Incomplete command.';
  const existing = store.get(name) ?? NetworkOsAccount.create({ name });
  const kw = args[1].toLowerCase();
  let next = existing;
  if (kw === 'password') {
    const idx = args.indexOf('cipher') >= 0 ? args.indexOf('cipher') : args.indexOf('irreversible-cipher');
    const algo: PasswordHashAlgorithm = idx >= 0
      ? (args[idx] === 'irreversible-cipher' ? 'irreversible-cipher' : 'cipher')
      : 'plain';
    const raw = args[idx >= 0 ? idx + 1 : args.length - 1] ?? existing.secret;
    const stored = algo === 'irreversible-cipher'
      ? (looksLikeIrreversibleCipher(raw) ? raw : huaweiIrreversibleCipher(raw))
      : algo === 'cipher'
        ? (looksLikeReversibleCipher(raw) ? raw : huaweiCipher(raw))
        : raw;
    if (algo === 'plain' && policy.minLength && raw.length < policy.minLength) {
      return `Error: The password must contain at least ${policy.minLength} characters.`;
    }
    if (existing.wouldReuseSecret(raw, policy.historyMaxRecords ?? 0)) {
      return 'Error: The password has been used before. Please choose a different one.';
    }
    next = existing.withSecretRetainingHistory(stored, algo, policy.historyMaxRecords ?? 0);
    if (policy.expireDays) {
      next = next.withPasswordExpireAt(Date.now() + policy.expireDays * 86_400_000);
    }
  } else if (kw === 'privilege' && args[2] === 'level' && args[3]) {
    next = existing.withPrivilege(Number(args[3]) || existing.privilege);
  } else if (kw === 'service-type') {
    const types = args.slice(2).filter(t => t.length > 0) as AccountServiceType[];
    next = existing.withServiceTypes(types);
  } else if (kw === 'state') {
    next = args[2] === 'active' ? existing.enable() : args[2] === 'block' ? existing.disable() : existing;
  } else if (kw === 'ftp-directory' && args[2]) {
    next = existing.withFtpDirectory(args[2]);
  } else if (kw === 'idle-timeout' && args[2]) {
    next = existing.withIdleTimeout(Number(args[2]) * 60);
  } else if (kw === 'access-limit' && args[2]) {
    next = existing.withMaxSessions(Number(args[2]));
  }
  store.upsert(next);
  return '';
}

export function localUserConfigLinesVrp(accounts: readonly NetworkOsAccount[]): string[] {
  return accounts.flatMap((u) => {
    const password = u.passwordHashAlgorithm === 'cipher'
      ? `password cipher ${looksLikeReversibleCipher(u.secret) ? u.secret : huaweiCipher(u.secret)}`
      : `password irreversible-cipher ${looksLikeIrreversibleCipher(u.secret) ? u.secret : huaweiIrreversibleCipher(u.secret)}`;
    return [
      ` local-user ${u.name} ${password}`,
      ` local-user ${u.name} privilege level ${u.privilege}`,
      ...(u.serviceTypes.length > 0 ? [` local-user ${u.name} service-type ${u.serviceTypes.join(' ')}`] : []),
    ];
  });
}
