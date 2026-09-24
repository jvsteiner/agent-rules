import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
// Keep the checkout's existing marketplace metadata in sync with its package.
const pkg=JSON.parse(await readFile('package.json','utf8'));
const marketplace=JSON.parse(await readFile('.claude-plugin/marketplace.json','utf8'));
for(const plugin of marketplace.plugins??[])if(plugin.name===pkg.name){plugin.version=pkg.version;plugin.description=pkg.description;}
await writeFile('.claude-plugin/marketplace.json',JSON.stringify(marketplace,null,2)+'\n');
await build({entryPoints:{'behavior-hook':'bin/behavior-hook.js','agent-rules':'bin/agent-rules.js'},outdir:'dist',bundle:true,platform:'node',target:'node20',format:'esm',minify:true,sourcemap:false,banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'}});
