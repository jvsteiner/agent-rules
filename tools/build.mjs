import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Every path is absolute from the repository root, so the build runs from any directory.
const root = resolve(import.meta.dirname, '..');
const at = (...parts) => join(root, ...parts);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

const pkg = await json(at('package.json'));
// The npm package that users install; the repository package itself is private.
const published = pkg.pluginPackage;

// Keep plugin manifests and the public marketplaces in sync with the package.
for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  const manifest = await json(at(file));
  manifest.version = pkg.version;
  await save(at(file), manifest);
}
const claudeMarketplace = await json(at('.claude-plugin/marketplace.json'));
for (const plugin of claudeMarketplace.plugins ?? []) if (plugin.name === pkg.name) {
  plugin.version = pkg.version; plugin.description = pkg.description;
  plugin.source = { source: 'npm', package: published };
}
await save(at('.claude-plugin/marketplace.json'), claudeMarketplace);
const codexMarketplace = await json(at('.agents/plugins/marketplace.json'));
for (const plugin of codexMarketplace.plugins ?? []) if (plugin.name === pkg.name) plugin.source = { source: 'npm', package: published };
await save(at('.agents/plugins/marketplace.json'), codexMarketplace);

await build({ entryPoints: { 'behavior-hook': at('bin/behavior-hook.js'), 'agent-rules': at('bin/agent-rules.js') }, outdir: at('dist'),
  bundle: true, platform: 'node', target: 'node20', format: 'esm', minify: true, sourcemap: false,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });

// Assemble the installable plugin: only what the hooks, CLI, and skills load at run time.
// This folder is the npm package, and also a local marketplace for development installs.
const plugin = at('plugin');
const shipped = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'hooks', 'dist', 'policies', 'rules', 'skills', 'omp', 'README.md', 'LICENSE'];
await rm(plugin, { recursive: true, force: true });
await mkdir(plugin);
for (const path of shipped) await cp(at(path), join(plugin, path), { recursive: true });
await save(join(plugin, 'package.json'), {
  name: published, version: pkg.version, description: pkg.description, license: pkg.license, author: pkg.author,
  repository: pkg.repository, type: 'module', engines: pkg.engines,
  bin: { 'agent-rules': 'dist/agent-rules.js' }, files: shipped,
});
// Development marketplaces that install this folder directly. They are not in `files`, so npm never ships them.
await mkdir(join(plugin, '.agents', 'plugins'), { recursive: true });
await save(join(plugin, '.claude-plugin', 'marketplace.json'), { ...claudeMarketplace,
  plugins: claudeMarketplace.plugins.map((p) => (p.name === pkg.name ? { ...p, source: './' } : p)) });
await save(join(plugin, '.agents', 'plugins', 'marketplace.json'), { ...codexMarketplace,
  plugins: codexMarketplace.plugins.map((p) => (p.name === pkg.name ? { ...p, source: { source: 'local', path: './' } } : p)) });
