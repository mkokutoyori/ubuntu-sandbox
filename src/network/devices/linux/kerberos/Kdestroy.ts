import { Getopt, GETOPT_END } from '@/network/ldap/openldap/getopt';
import { Krb5Context } from './Krb5Context';
import { FileCredentialCache, ccachePathOf, fromCcachePrincipal, parseCcacheName } from './Krb5Ccache';
import { unparsePrincipal } from './Krb5Principal';
import { KDESTROY_USAGE, emit, outputOf, type ToolOutput } from './Krb5ToolOutput';
import type { Krb5Host } from './Krb5Host';

export async function runKdestroy(host: Krb5Host, args: readonly string[]): Promise<ToolOutput> {
  const out = outputOf();
  let cacheName: string | null = null;
  let principalName: string | null = null;
  let allCaches = false;
  let optionError = false;
  const getopt = new Getopt(['kdestroy', ...args], 'Aqc:p:', (message) => { emit(out, 'stderr', `${message}\n`); });
  for (;;) {
    const result = getopt.next();
    if (result === GETOPT_END) break;
    switch (result.option) {
      case 'A': allCaches = true; break;
      case 'c': cacheName = result.argument; break;
      case 'p': principalName = result.argument; break;
      case '?': optionError = true; break;
      default: break;
    }
  }
  if (optionError || getopt.operands().length > 0) {
    emit(out, 'stderr', `${KDESTROY_USAGE}\n`);
    out.exitCode = 2;
    return out;
  }
  const context = new Krb5Context(host);
  const name = cacheName ?? context.defaultCcacheName();
  const parsed = parseCcacheName(name);
  const path = ccachePathOf(parsed);
  if (path === null) {
    emit(out, 'stderr', 'kdestroy: Unknown credential cache type while destroying cache\n');
    out.exitCode = 1;
    return out;
  }
  const store = new FileCredentialCache(host, path);
  if (principalName !== null) {
    const cache = store.read();
    const wanted = context.parseName(principalName);
    if (cache === null || !wanted.ok || unparsePrincipal(fromCcachePrincipal(cache.defaultPrincipal)) !== unparsePrincipal(wanted.principal)) {
      emit(out, 'stderr', `kdestroy: Matching credential not found while finding cache for ${principalName}\n`);
      out.exitCode = 1;
      return out;
    }
  }
  if (!store.exists()) {
    if (!allCaches) emit(out, 'stderr', 'kdestroy: No credentials cache found while destroying cache\n');
    return out;
  }
  store.destroy();
  return out;
}
