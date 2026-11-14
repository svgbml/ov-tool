// Genereert het Android (TWA) project voor OV-tool. Gebruik: node gen.mjs <host> <iconBase>
import { TwaManifest, TwaGenerator, ConsoleLog } from '@bubblewrap/core';
import { rmSync } from 'node:fs';
const [host, iconBase] = process.argv.slice(2);
const dir = new URL('./project/', import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
const m = new TwaManifest({
  packageId: 'io.github.svgbml.ovtool',
  host,
  name: 'OV-tool',
  launcherName: 'OV-tool',
  display: 'standalone',
  orientation: 'portrait',
  themeColor: '#FFFFFF',
  themeColorDark: '#09090B',
  navigationColor: '#FFFFFF',
  navigationColorDark: '#09090B',
  navigationDividerColor: '#E4E4E7',
  navigationDividerColorDark: '#27272A',
  backgroundColor: '#FAFAFA',
  enableNotifications: true,
  startUrl: '/',
  iconUrl: `${iconBase}/icons/icon-512.png`,
  maskableIconUrl: `${iconBase}/icons/icon-512.png`,
  monochromeIconUrl: `${iconBase}/icons/badge-96.png`,
  splashScreenFadeOutDuration: 300,
  signingKey: { path: process.env.KEYSTORE || 'ovtool.keystore', alias: 'ovtool' },
  appVersionName: process.env.APP_VERSION || '1.0.0',
  appVersionCode: Number(process.env.APP_CODE || 1),
  shortcuts: [],
  generatorApp: 'bubblewrap-cli',
  webManifestUrl: `${iconBase}/manifest.webmanifest`,
  fallbackType: 'customtabs',
  features: {},
  enableSiteSettingsShortcut: true,
  isChromeOSOnly: false,
  isMetaQuest: false,
  fullScopeUrl: `https://${host}/`,
  minSdkVersion: 24,
  fingerprints: [],
  additionalTrustedOrigins: [],
  retainedBundles: [],
  appVersion: process.env.APP_VERSION || '1.0.0',
});
await new TwaGenerator().createTwaProject(dir, m, new ConsoleLog('gen'));
console.log('project gegenereerd voor', host);
