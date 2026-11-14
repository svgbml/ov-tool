// Kopieert de webapp naar ./public en zet de Digital Asset Links voor de Android-app klaar.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const out = new URL('./public/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out + '.well-known', { recursive: true });
for (const f of ['index.html', 'style.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'icons']) {
  cpSync(root + f, out + f, { recursive: true });
}
const cfg = JSON.parse(readFileSync(new URL('./android.json', import.meta.url)));
const links = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: cfg.packageId, sha256_cert_fingerprints: cfg.sha256 },
}];
writeFileSync(out + '.well-known/assetlinks.json', JSON.stringify(links, null, 2));
writeFileSync(out + '.assetsignore', '');
console.log('public/ klaar', existsSync(out + 'index.html'));
