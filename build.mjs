import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { minify } from 'html-minifier-terser';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'src'), { recursive: true });
await cp(join(root, 'icons'), join(dist, 'icons'), { recursive: true });

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest));

for (const name of await readdir(src)) {
  const from = join(src, name);
  const to = join(dist, 'src', name);
  let text = await readFile(from, 'utf8');
  if (name === 'main-world.js') {
    // Test-only seam; never shipped.
    text = text.replace(/\/\* UTK_TEST_SEAM_START \*\/[\s\S]*?\/\* UTK_TEST_SEAM_END \*\//, '');
  }
  if (name.endsWith('.js') || name.endsWith('.css')) {
    const out = await transform(text, {
      loader: name.endsWith('.js') ? 'js' : 'css',
      minify: true,
      legalComments: 'none',
      target: 'chrome120',
    });
    await writeFile(to, out.code);
  } else if (name.endsWith('.html')) {
    await writeFile(
      to,
      await minify(text, {
        collapseWhitespace: 'conservative',
        removeComments: true,
        keepClosingSlash: true,
      }),
    );
  } else {
    await cp(from, to);
  }
}

console.log('built dist/');
