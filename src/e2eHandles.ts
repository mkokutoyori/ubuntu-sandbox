import { useNetworkStore } from './store/networkStore';
import { getFaultRegistry } from './network/faults';
import { loadAllDevicePlatforms } from './network/devices/platformLoaders';
import { platformsStayLazy } from './lazyPlatforms';

function drivenByAutomation(): boolean {
  return globalThis.navigator?.webdriver === true;
}

export async function installE2eHandles(): Promise<void> {
  const target = window as unknown as Record<string, unknown>;
  if (drivenByAutomation() && !platformsStayLazy()) {
    await loadAllDevicePlatforms();
  }
  target.__faults = getFaultRegistry();
  target.__networkStore = useNetworkStore;
}
