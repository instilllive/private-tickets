import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const packageDir = join(root.pathname, 'node_modules', 'html5-qrcode');
const destDir = join(root.pathname, 'public', 'vendor');
const dest = join(destDir, 'html5-qrcode.min.js');

if (!existsSync(packageDir)) {
  console.error('copy-vendor: html5-qrcode is not installed');
  process.exit(1);
}

function findBuild(dir) {
  const preferred = [
    join(dir, 'html5-qrcode.min.js'),
    join(dir, 'minified', 'html5-qrcode.min.js'),
  ];
  for (const path of preferred) {
    if (existsSync(path)) return path;
  }
  const matches = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        if (name === 'node_modules' || name === '.git') continue;
        stack.push(path);
      } else if (name.includes('html5-qrcode') && name.endsWith('.min.js')) {
        matches.push(path);
      }
    }
  }
  return matches.sort((a, b) => a.length - b.length)[0] ?? null;
}

const source = findBuild(packageDir);
if (!source) {
  console.error('copy-vendor: could not find html5-qrcode.min.js');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
console.log(`copy-vendor: ${source} -> ${dest}`);
