import type { LinuxPamHost } from './PamLinuxHost';
import { PamModuleRegistry } from './PamModule';
import { pamAccessModule } from './modules/PamAccessModule';
import { pamCapModule } from './modules/PamCapModule';
import { pamEnvModule } from './modules/PamEnvModule';
import { pamFaillockModule } from './modules/PamFaillockModule';
import { pamLimitsModule } from './modules/PamLimitsModule';
import { pamListfileModule, pamSucceedIfModule, pamWheelModule } from './modules/PamAccessControlModules';
import { pamGroupModule } from './modules/PamGroupModule';
import { pamKeyinitModule } from './modules/PamKeyinitModule';
import { pamMailModule } from './modules/PamMailModule';
import { pamMotdModule } from './modules/PamMotdModule';
import { pamDenyModule, pamNologinModule, pamPermitModule, pamRootokModule, pamSelinuxModule } from './modules/PamTrivialModules';
import { pamFaildelayModule, pamLoginuidModule, pamShellsModule, pamUmaskModule } from './modules/PamSessionModules';
import { pamPwqualityModule } from './modules/PamPwqualityModule';
import { pamTimeModule } from './modules/PamTimeModule';
import { pamUnixModule } from './modules/PamUnixModule';

export function createLinuxPamModules(): PamModuleRegistry<LinuxPamHost> {
  return new PamModuleRegistry<LinuxPamHost>()
    .register('pam_unix', pamUnixModule)
    .register('pam_deny', pamDenyModule)
    .register('pam_permit', pamPermitModule)
    .register('pam_rootok', pamRootokModule)
    .register('pam_nologin', pamNologinModule)
    .register('pam_faillock', pamFaillockModule)
    .register('pam_wheel', pamWheelModule)
    .register('pam_succeed_if', pamSucceedIfModule)
    .register('pam_listfile', pamListfileModule)
    .register('pam_access', pamAccessModule)
    .register('pam_cap', pamCapModule)
    .register('pam_env', pamEnvModule)
    .register('pam_limits', pamLimitsModule)
    .register('pam_pwquality', pamPwqualityModule)
    .register('pam_group', pamGroupModule)
    .register('pam_keyinit', pamKeyinitModule)
    .register('pam_mail', pamMailModule)
    .register('pam_motd', pamMotdModule)
    .register('pam_selinux', pamSelinuxModule)
    .register('pam_time', pamTimeModule)
    .register('pam_umask', pamUmaskModule)
    .register('pam_loginuid', pamLoginuidModule)
    .register('pam_shells', pamShellsModule)
    .register('pam_faildelay', pamFaildelayModule);
}
