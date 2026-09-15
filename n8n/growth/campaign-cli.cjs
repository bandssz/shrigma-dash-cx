#!/usr/bin/env node
/* Local contract check for AI clients. No credentials, HTTP calls or campaign writes. */
'use strict';
const fs=require('node:fs'),C=require('./campaign-contract');
const file=process.argv[2];
if(!file||process.argv.length!==3){process.stderr.write('Uso: node n8n/growth/campaign-cli.cjs campanha.json > campanha-conferida.json\n');process.exitCode=2;}
else{try{const content=fs.readFileSync(file);if(content.length>800000)throw Error('Arquivo acima de 800 KB.');const result=C.normalize(JSON.parse(content.toString('utf8')));process.stdout.write(JSON.stringify(result,null,2)+'\n');}
catch(e){process.stderr.write(JSON.stringify({error:e.code||'DEFINITION_INVALID',field:e.field||null,message:e instanceof SyntaxError?'JSON inválido.':e.message})+'\n');process.exitCode=1;}}
