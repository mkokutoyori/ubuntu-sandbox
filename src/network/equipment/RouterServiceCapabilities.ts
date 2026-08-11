/**
 * Segregated router/switch service-accessor capabilities.
 *
 * Concrete device classes (`Router`, `HuaweiRouter`, `CiscoRouter`,
 * `GenericSwitch`, …) implement these optional getters directly, but
 * shell/protocol code is typed against a narrower shared interface
 * (`CiscoDevice`, `ICLIDevice`, a raw `Equipment`) that doesn't declare
 * them — by design, per `CiscoDevice`'s own Interface Segregation
 * comment. Every call site used to respell its own copy of the same
 * `(dev as unknown as { getXxx?: () => Yyy }).getXxx?.()` structural cast
 * inline; this centralizes them into one named, reviewed boundary
 * (rapport 08 audit — reduce unencapsulated `as unknown as`/`as any`).
 */

import type { Equipment } from './Equipment';
import type { RouterManagementService } from '../devices/router/management/RouterManagementService';
import type { CiscoHttpService } from '../devices/router/management/CiscoHttpService';
import type { SnmpService } from '../devices/router/management/SnmpService';
import type { SnmpAgent } from '../snmp/SnmpAgent';
import type { NtpAgent } from '../ntp/NtpAgent';
import type { HsrpAgent } from '../hsrp/HsrpAgent';
import type { GlbpAgent } from '../glbp/GlbpAgent';
import type { VrrpAgent } from '../vrrp/VrrpAgent';
import type { HuaweiRoutingExtras } from '../devices/router/routing/HuaweiRoutingExtras';
import type { SwitchSecurityService } from '../devices/switch/SwitchSecurityService';
import type { NetworkOsCredentialStore } from '../devices/router/aaa/NetworkOsCredentialStore';

export interface ManagementServiceHost { getManagementService(): RouterManagementService; }
export interface CiscoHttpServiceHost { getHttpService(): CiscoHttpService; }
export interface SnmpServiceHost { getSnmpService(): SnmpService; }
export interface SnmpAgentHost { getSnmpAgent(): SnmpAgent; }
export interface NtpAgentHost { getNtpAgent(): NtpAgent; }
export interface HsrpAgentHost { getHsrpAgent(): HsrpAgent; }
export interface GlbpAgentHost { getGlbpAgent(): GlbpAgent; }
export interface VrrpAgentHost { getVrrpAgent(): VrrpAgent; }
export interface HuaweiRoutingExtrasHost { getHuaweiRoutingExtras(): HuaweiRoutingExtras; }
export interface SwitchSecurityServiceHost { getSecurityService(): SwitchSecurityService; }
export interface CredentialStoreHost { getCredentialStore(): NetworkOsCredentialStore; }

/** An `Equipment` that MAY expose any of the optional services above. */
export type ServiceCapableDevice = Equipment & Partial<
  ManagementServiceHost & CiscoHttpServiceHost &
  SnmpServiceHost & SnmpAgentHost & NtpAgentHost &
  HsrpAgentHost & GlbpAgentHost & VrrpAgentHost &
  HuaweiRoutingExtrasHost & SwitchSecurityServiceHost & CredentialStoreHost
>;

/** The one boundary in this file where the structural cast actually happens. */
function call<T>(dev: unknown, name: string): T | undefined {
  const fn = (dev as Record<string, unknown> | null)?.[name];
  return typeof fn === 'function' ? (fn as () => T).call(dev) : undefined;
}

export const getManagementService = (dev: unknown): RouterManagementService | undefined =>
  call(dev, 'getManagementService');
export const getHttpService = (dev: unknown): CiscoHttpService | undefined =>
  call(dev, 'getHttpService');
export const getSnmpService = (dev: unknown): SnmpService | undefined =>
  call(dev, 'getSnmpService');
export const getSnmpAgent = (dev: unknown): SnmpAgent | undefined =>
  call(dev, 'getSnmpAgent');
export const getNtpAgent = (dev: unknown): NtpAgent | undefined =>
  call(dev, 'getNtpAgent');
export const getHsrpAgent = (dev: unknown): HsrpAgent | undefined =>
  call(dev, 'getHsrpAgent');
export const getGlbpAgent = (dev: unknown): GlbpAgent | undefined =>
  call(dev, 'getGlbpAgent');
export const getVrrpAgent = (dev: unknown): VrrpAgent | undefined =>
  call(dev, 'getVrrpAgent');
export const getHuaweiRoutingExtras = (dev: unknown): HuaweiRoutingExtras | undefined =>
  call(dev, 'getHuaweiRoutingExtras');
export const getSwitchSecurityService = (dev: unknown): SwitchSecurityService | undefined =>
  call(dev, 'getSecurityService');
export const getCredentialStore = (dev: unknown): NetworkOsCredentialStore | undefined =>
  call(dev, 'getCredentialStore');
