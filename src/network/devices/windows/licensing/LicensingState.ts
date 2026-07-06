/**
 * LicensingState — Windows activation/licensing minimal (PRD-Windows-
 * Server-Advanced.md §5 P21, §2.1.20): a simulated per-machine license
 * state (`slmgr.vbs /ipk`/`/ato`/`/dlv`, `Get-CimInstance
 * SoftwareLicensingProduct`). Purely declarative — a product key only
 * needs to match the real-world `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` shape;
 * **no real cryptographic key verification** is performed, matching every
 * KMS/MAK server this simulator does not (and will never) implement.
 */

export type LicenseState = 'Unlicensed' | 'Licensed' | 'OutOfBoxGrace' | 'Notification';

export interface LicensingOpResult { ok: boolean; message: string }

const PRODUCT_KEY_PATTERN = /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i;

/** Real `SL_ACTIVATION_STATUS`-style numeric codes, as `Get-CimInstance SoftwareLicensingProduct`'s `LicenseStatus` reports them. */
export const LICENSE_STATUS_CODE: Record<LicenseState, number> = {
  Unlicensed: 0,
  Licensed: 1,
  OutOfBoxGrace: 2,
  Notification: 5,
};

/** One machine's simulated activation state — every fresh install starts `Notification` (unactivated, past any initial grace window), matching the common steady state of an unattended lab image. */
export class WindowsLicensingState {
  private state: LicenseState = 'Notification';
  private productKey: string | null = null;

  getState(): LicenseState { return this.state; }
  getProductKey(): string | null { return this.productKey; }

  /** `slmgr /ipk <key>` — format-only validation, no cryptographic check. */
  installProductKey(key: string): LicensingOpResult {
    if (!PRODUCT_KEY_PATTERN.test(key)) {
      return { ok: false, message: 'Error: 0xC004F014 The Software Licensing Service reported that the product key is invalid.' };
    }
    this.productKey = key.toUpperCase();
    return { ok: true, message: 'Installed product key XXXXX-XXXXX-XXXXX-XXXXX-' + this.productKey.slice(-5) + ' successfully.' };
  }

  /** `slmgr /ato` — activates against the installed key. A fictitious KMS/MAK key is all that's ever required (PRD §5 P21). */
  activate(): LicensingOpResult {
    if (!this.productKey) {
      return { ok: false, message: 'Error: 0xC004F015 The Software Licensing Service reported that the product key is not available.' };
    }
    this.state = 'Licensed';
    return { ok: true, message: 'Product activated successfully.' };
  }
}
