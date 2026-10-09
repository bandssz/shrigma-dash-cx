'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const expected='d1c59de603cb00eee03b4d924e3bfcf275848b90de21b7ebb07f8534bb051df7';
const raw=fs.readFileSync(path.join(__dirname,'manifest.json'));if(hash(raw)!==expected)throw Error('INSTALLER_CATALOG_REFUSED');
const manifest=JSON.parse(raw),entries=new Map();
for(const m of manifest.migrations){const p=path.join(__dirname,'migrations',m.file),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('INSTALLER_CATALOG_REFUSED');const b=fs.readFileSync(p);if(b.length!==m.bytes||hash(b)!==m.sha256)throw Error('INSTALLER_CATALOG_REFUSED');const sql=b.toString('utf8'),start=sql.indexOf('\nBEGIN;')+1,end=sql.lastIndexOf('\nCOMMIT;')+1;if(!start||end<=start||sql.slice(end+7).trim())throw Error('INSTALLER_CATALOG_REFUSED');const body=sql.slice(0,start)+sql.slice(start+6,end)+sql.slice(end+7);if(hash(body)!==m.executionSha256)throw Error('INSTALLER_CATALOG_REFUSED');entries.set(m.id,{...m,sql:body});}
const clone=x=>JSON.parse(JSON.stringify(x));
module.exports=Object.freeze({manifestHash:expected,manifest:()=>clone(manifest),get:id=>entries.has(id)?clone(entries.get(id)):null,hash});
