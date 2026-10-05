'use strict';
// Public request file only. No private key, env credential, PG or MCP.
const B=require('./stdio-bridge.cjs');
try{
 if(process.argv.length!==5)throw Error();
 const [, ,file,sha256,size]=process.argv;if(!/^[1-9][0-9]{0,5}$/.test(size))throw Error();
 process.stdout.write(JSON.stringify(B.readPublicFile({path:file,sha256,bytes:Number(size)}))+'\n');
}catch{process.stderr.write('READ_STDIO_PUBLIC_READBACK_REFUSED\n');process.exitCode=1;}
