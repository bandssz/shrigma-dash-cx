'use strict';
const TRANSIENT_CODES=new Set(['ECONNRESET','ECONNREFUSED','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
function transportCode(error){return [error?.code,error?.cause?.code].find(code=>TRANSIENT_CODES.has(code))||null;}
// A single retry is admitted only for an explicitly read-only operation.
async function retryRead(read,{wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),validate=()=>{}}={}){
 for(let attempt=0;attempt<2;attempt++){
  validate();
  try{const result=await read();validate();return result;}
  catch(error){if(attempt!==0||!transportCode(error))throw error;validate();await wait(500);validate();}
 }
}
module.exports={retryRead,transportCode};
