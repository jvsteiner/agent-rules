#!/usr/bin/env node
// Explicit local launcher: parses only TYPESAFE_API_KEY, never evaluates .env as shell code.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
const [envFile,command,...args]=process.argv.slice(2);
if(!envFile||!['claude','codex'].includes(command))throw new Error('Usage: node tools/with-key.mjs <explicit.env> claude|codex [arguments]');
const parsed=parseEnv(readFileSync(envFile,'utf8'));
if(!parsed.TYPESAFE_API_KEY)throw new Error('The specified file has no TYPESAFE_API_KEY.');
const child=spawn(command,args,{stdio:'inherit',env:{...process.env,TYPESAFE_API_KEY:parsed.TYPESAFE_API_KEY}});
child.on('error',()=>{console.error('Could not start the selected host.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
