const fs = require('node:fs');
const path = require('node:path');

// Only these browser assets are allowed into the public deployment directory.
const files = [
  'index.html', '404.html', 'css/styles.css',
  'js/app.js', 'js/firebase-config.js', 'js/firebase-service.js', 'js/ui-accessibility.js',
  'assets/crazsix-logo.png', 'assets/crazsix-logo-banner.png'
];
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.rmSync(output, { recursive: true, force: true });
for (const file of files) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
console.log(`Prepared ${files.length} website files in dist/`);
