/**
 * IamPolicyFilesProjection — reactive bridge that keeps the on-disk PAM
 * password-policy configuration coherent with the in-memory policy model.
 *
 * `LinuxUserManager` mutates the {@link PasswordPolicy} aggregate and
 * publishes a `linux.iam.password-policy.changed` event — it does *not* touch
 * the filesystem itself. This projection subscribes to that event and asks
 * the manager to re-materialise the file backing the section that changed:
 *   - `quality` → `/etc/security/pwquality.conf` (+ `/etc/pam.d/common-password`)
 *   - `aging`   → `/etc/login.defs`
 *   - `lockout` → `/etc/security/faillock.conf`
 *
 * Mirrors {@link IamAuthLogProjection}: the manager announces, the projection
 * keeps a derived view coherent as a pure side-effect of the event stream.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { PasswordPolicyChangedPayload } from '../events';

/** The slice of `LinuxUserManager` this projection drives. */
export interface PolicyFilesystemTarget {
  applyPolicyToFilesystem(section: 'quality' | 'aging' | 'lockout'): void;
}

export class IamPolicyFilesProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly manager: PolicyFilesystemTarget,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.iam.password-policy.changed', (e) =>
        this.onPolicyChanged(e.payload),
      ),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onPolicyChanged(payload: PasswordPolicyChangedPayload): void {
    if (payload.deviceId !== this.deviceId) return;
    this.manager.applyPolicyToFilesystem(payload.section);
  }
}
