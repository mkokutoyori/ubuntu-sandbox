import { toast } from 'sonner';
import { useNetworkStore } from '@/store/networkStore';
import { getLocale, translate } from '@/i18n';
import { deploymentSkewHandler, isChunkLoadFailure, type DeploymentSkewHost } from './deploymentSkew';

const RELOAD_KEY = 'ubuntu-sandbox.skew-reload-at';
const TOAST_ID = 'deployment-skew';

function readReloadAt(): number | null {
  try {
    const stored = globalThis.sessionStorage?.getItem(RELOAD_KEY);
    return stored === null || stored === undefined ? null : Number(stored);
  } catch {
    return null;
  }
}

function writeReloadAt(at: number): void {
  try {
    globalThis.sessionStorage?.setItem(RELOAD_KEY, String(at));
  } catch {
    return;
  }
}

const browserHost: DeploymentSkewHost = {
  nothingToLose: () => useNetworkStore.getState().deviceInstances.size === 0,
  lastReloadAt: readReloadAt,
  rememberReloadAt: writeReloadAt,
  now: () => Date.now(),
  reload: () => window.location.reload(),
  announce: () => {
    const locale = getLocale();
    toast.error(translate(locale, 'app.newVersionTitle'), {
      id: TOAST_ID,
      description: translate(locale, 'app.newVersionDescription'),
      duration: Number.POSITIVE_INFINITY,
      action: { label: translate(locale, 'app.reload'), onClick: () => window.location.reload() },
    });
  },
};

const handleSkew = deploymentSkewHandler(browserHost);

export function installDeploymentSkewGuard(): void {
  window.addEventListener('vite:preloadError', () => { handleSkew(); });
}

export function reportChunkFailure(error: unknown): boolean {
  if (!isChunkLoadFailure(error)) return false;
  handleSkew();
  return true;
}
