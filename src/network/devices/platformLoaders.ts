import type { DeviceType } from '../core/types';
import { isDevicePlatformLoaded } from './deviceBuilders';

const PLATFORM_LOADERS: Partial<Record<DeviceType, () => Promise<unknown>>> = {
  'linux-pc': () => import('./platforms/linuxPlatform'),
  'mac-pc': () => import('./platforms/linuxPlatform'),
  'linux-server': () => import('./platforms/linuxPlatform'),
  'firewall-paloalto': () => import('./platforms/linuxPlatform'),
  'cloud': () => import('./platforms/linuxPlatform'),
  'windows-pc': () => import('./platforms/windowsPlatform'),
  'windows-server': () => import('./platforms/windowsPlatform'),
  'switch-cisco': () => import('./platforms/ciscoPlatform'),
  'router-cisco': () => import('./platforms/ciscoPlatform'),
  'switch-huawei': () => import('./platforms/huaweiPlatform'),
  'router-huawei': () => import('./platforms/huaweiPlatform'),
  'switch-generic': () => import('./platforms/genericPlatform'),
  'hub': () => import('./platforms/genericPlatform'),
  'access-point': () => import('./platforms/genericPlatform'),
  'firewall-cisco': () => import('./platforms/asaPlatform'),
  'firewall-fortinet': () => import('./platforms/fortigatePlatform'),
};

const pending = new Map<DeviceType, Promise<void>>();

export function hasDevicePlatform(type: DeviceType): boolean {
  return PLATFORM_LOADERS[type] !== undefined;
}

export function loadDevicePlatform(type: DeviceType): Promise<void> {
  if (isDevicePlatformLoaded(type)) return Promise.resolve();
  let loading = pending.get(type);
  if (loading === undefined) {
    const loader = PLATFORM_LOADERS[type];
    if (loader === undefined) return Promise.reject(new Error(`Unknown device type: ${type}`));
    loading = loader().then(() => undefined, (error) => {
      pending.delete(type);
      throw error;
    });
    pending.set(type, loading);
  }
  return loading;
}

export async function loadDevicePlatforms(types: Iterable<DeviceType>): Promise<void> {
  await Promise.all([...new Set(types)].map((type) => loadDevicePlatform(type)));
}

export function loadAllDevicePlatforms(): Promise<void> {
  return loadDevicePlatforms(Object.keys(PLATFORM_LOADERS) as DeviceType[]);
}
