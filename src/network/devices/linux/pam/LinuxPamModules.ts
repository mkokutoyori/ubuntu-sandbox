import type { LinuxPamHost } from './PamLinuxHost';
import { PamModuleRegistry } from './PamModule';
import { pamFaillockModule } from './modules/PamFaillockModule';
import { pamListfileModule, pamSucceedIfModule, pamWheelModule } from './modules/PamAccessControlModules';
import { pamDenyModule, pamNologinModule, pamPermitModule, pamRootokModule } from './modules/PamTrivialModules';
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
    .register('pam_listfile', pamListfileModule);
}
