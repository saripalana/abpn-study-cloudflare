import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const read=relative=>readFile(path.join(root,relative),'utf8');

test('required application assets exist',async()=>{for(const file of ['public/index.html','public/app.js','public/styles.css','public/client/storage.js','public/client/study-engine.js','public/banks/catalog.js'])await access(path.join(root,file))});

test('all static module imports resolve inside public assets',async()=>{const app=await read('public/app.js');const imports=[...app.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);for(const specifier of imports){if(specifier.startsWith('.')){const resolved=path.resolve(root,'public',specifier);await access(resolved)}}});

test('production browser assets contain no Google service dependency',async()=>{const text=(await Promise.all(['public/index.html','public/app.js','public/client/storage.js','src/worker.js'].map(read))).join('\n').toLowerCase();for(const forbidden of ['googleapis','accounts.google.com','drive.google.com','gapi','google oauth'])assert.equal(text.includes(forbidden),false,`forbidden dependency found: ${forbidden}`)});

test('site identity and question-bank identity remain separate',async()=>{const html=await read('public/index.html');const catalog=await read('public/banks/catalog.js');assert.match(html,/ABPN PSYCHIATRY STUDY/);assert.doesNotMatch(html,/K&S Psychiatry Question Bank/);assert.match(catalog,/System Validation Question Bank/)});
