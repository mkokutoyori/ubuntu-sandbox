/**
 * `slmgr` / `slmgr.vbs` — Software Licensing Management Tool (PRD-Windows-
 * Server-Advanced.md §5 P21, §2.1.20): `/ipk`, `/ato`, `/dlv`, `/dli`.
 */
import type { WindowsLicensingState } from './licensing/LicensingState';

export interface SlmgrContext {
  productName: string;
  licensing: WindowsLicensingState;
}

export function cmdSlmgr(ctx: SlmgrContext, args: string[]): string {
  const flag = args[0];

  if (flag === '/ipk') {
    const key = args[1] ?? '';
    return ctx.licensing.installProductKey(key).message;
  }

  if (flag === '/ato') {
    return ctx.licensing.activate().message;
  }

  if (flag === '/dlv' || flag === '/dli') {
    const key = ctx.licensing.getProductKey();
    const partial = key ? key.slice(-5) : '';
    const lines = [
      `Name: ${ctx.productName}`,
      `Description: ${ctx.productName} edition`,
      `Partial Product Key: ${partial}`,
      `License Status: ${ctx.licensing.getState()}`,
    ];
    return lines.join('\n');
  }

  return 'Usage: slmgr.vbs [/ipk <ProductKey> | /ato | /dlv | /dli]';
}
