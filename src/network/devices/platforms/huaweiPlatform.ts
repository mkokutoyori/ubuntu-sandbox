import { registerDeviceBuilder } from '../deviceBuilders';
import { HuaweiSwitch } from '../HuaweiSwitch';
import { HuaweiRouter } from '../HuaweiRouter';

registerDeviceBuilder('switch-huawei', (name, x, y) => new HuaweiSwitch('switch-huawei', name, 24, x, y));
registerDeviceBuilder('router-huawei', (name, x, y) => new HuaweiRouter(name, x, y));
