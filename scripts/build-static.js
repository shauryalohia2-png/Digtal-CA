// Copies only the front-end files into public/ for Vercel's CDN, so server
// source, config, database files and the legacy copy are never published.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public');
const STATIC_FILES = /\.(html|css|js)$/i;
const SKIP = new Set(['server.js']);
const STATIC_DIRS = ['assets'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copied = [];
for (const name of fs.readdirSync(root)) {
  const full = path.join(root, name);
  if (fs.statSync(full).isFile() && STATIC_FILES.test(name) && !SKIP.has(name)) {
    fs.copyFileSync(full, path.join(out, name));
    copied.push(name);
  }
}
for (const dir of STATIC_DIRS) {
  const src = path.join(root, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(out, dir), { recursive: true });
    copied.push(`${dir}/`);
  }
}

console.log(`✓ Static build: ${copied.length} entries → public/ (${copied.join(', ')})`);
