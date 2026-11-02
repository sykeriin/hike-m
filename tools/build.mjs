import * as esbuild from 'esbuild';
import fs from 'fs';
const r = await esbuild.build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\/script');
const tpl = fs.readFileSync('tools/template.html', 'utf8');
const out = tpl.replace('/*BUNDLE*/', () => js);
fs.writeFileSync('mongolia-ridge.html', out);
console.log('built', (out.length / 1024).toFixed(0) + ' KB');
