import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const read=relative=>readFile(path.join(root,relative),'utf8');

test('required application assets exist',async()=>{for(const file of ['public/index.html','public/app.js','public/styles.css','public/client/storage.js','public/client/study-engine.js','public/client/starter-decks.js','public/banks/catalog.js'])await access(path.join(root,file))});

test('all static module imports resolve inside public assets',async()=>{const files=['public/app.js','public/bootstrap.js','public/client/starter-decks.js'];for(const file of files){const source=await read(file);const directory=path.dirname(path.join(root,file));const imports=[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);for(const specifier of imports){if(specifier.startsWith('.'))await access(path.resolve(directory,specifier))}}});

test('production browser assets contain no Google service dependency',async()=>{const text=(await Promise.all(['public/index.html','public/app.js','public/client/storage.js','public/client/starter-decks.js','src/worker.js'].map(read))).join('\n').toLowerCase();for(const forbidden of ['googleapis','accounts.google.com','drive.google.com','gapi','google oauth'])assert.equal(text.includes(forbidden),false,`forbidden dependency found: ${forbidden}`)});

test('site identity remains separate while all decks come from the same library path',async()=>{const html=await read('public/index.html');const catalog=await read('public/banks/catalog.js');const starters=await read('public/client/starter-decks.js');assert.match(html,/ABPN PSYCHIATRY STUDY/);assert.doesNotMatch(html,/K&S Psychiatry Question Bank/);assert.match(catalog,/QUESTION_BANKS = \[\]/);assert.match(starters,/System Validation Question Bank/);assert.match(starters,/K&S Psychiatry Question Bank/);assert.match(starters,/publishCloudDeckPackage/)});
