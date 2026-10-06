export const SASL_PLUGIN_DIRECTORY = '/usr/lib/x86_64-linux-gnu/sasl2';
export const SASL_PLUGIN_VERSION = '2.0.25';

export const LIBSASL2_MODULES_PLUGINS: readonly string[] = [
  'libanonymous', 'libcrammd5', 'libdigestmd5', 'liblogin', 'libntlm', 'libplain', 'libscram',
];

export const LIBSASL2_MODULES_GSSAPI_PLUGINS: readonly string[] = ['libgs2', 'libgssapiv2'];

export function pluginFileNames(plugin: string): readonly string[] {
  return [`${plugin}.so`, `${plugin}.so.2`, `${plugin}.so.${SASL_PLUGIN_VERSION}`];
}

export function pluginFilePaths(plugins: readonly string[]): readonly string[] {
  return plugins.flatMap((plugin) => pluginFileNames(plugin).map((name) => `${SASL_PLUGIN_DIRECTORY}/${name}`));
}
