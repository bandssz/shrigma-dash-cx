'use strict';
const crypto=require('node:crypto');
// Only token identity of three linked components, never SQL interpretation.
const LIMITS=Object.freeze({bytes:65536,tokens:16384,depth:64});
const CANONICAL=Object.freeze({path:'inputs/canonical/CANONICAL-NORMALIZED.sql',bytes:4739,sha256:'c36b1077a333457782d944f28e8435120862833fbc9a34ab3bbc1fca0134fd28',postgresVersionNum:170005,recent:'b77a58863a74608fceb27eb2fe727b09150ca12b249750a86bceae9c816e408f',brands:'fcb8b3527091d450ede4b31ed05ad130ded97d3170f18bbe6f5ba642e2ae023f',value:'47c1aad050dde6e31dd667af2ce9fabc8a4f4d2ee541187a4ac27219afc42ebe'});
const UNKNOWN=Object.freeze({structure_status:'unknown',definition_tokens_sha256:null,recent_cte_tokens_sha256:null,brands_cte_tokens_sha256:null,brands_value_tokens_sha256:null,canonical_recent_match:null,canonical_brands_cte_match:null,canonical_brands_value_match:null});
const OPS=new Set(['::','=','<','>','<=','>=','<>','!=','+','-','*','/','%','||','->','->>','#>','#>>','~','!~']);
const FUNCTIONS=new Set(['jsonb_build_object','jsonb_agg','clock_timestamp','count','now','coalesce']);
const CALL_WORDS=new Set(['as','exists','any','filter','values','using','from','on','where','not','select','and','or']);
const FORBIDDEN=new Set(['union','intersect','except','insert','update','delete','merge','create','alter','drop','grant','revoke','with','returning','into','lateral']);
const KEYS=['schema_version','checked_at','collector','queue','pending_ingest_15min','conflicts','brands'];
const fail=()=>{throw 0;};
const white=c=>c===' '||c==='\t'||c==='\r'||c==='\n'||c==='\f'||c==='\v';
const digit=c=>c>='0'&&c<='9';
const letter=c=>!!c&&(c>='A'&&c<='Z'||c>='a'&&c<='z'||c==='_'||c.charCodeAt(0)>127);
const hash=t=>crypto.createHash('sha256').update(JSON.stringify(t.map(x=>[x.k,x.v]))).digest('hex');
function tokenize(source){
 if(typeof source!=='string'||!source||Buffer.byteLength(source,'utf8')>LIMITS.bytes||source.includes('\0')||Buffer.from(source,'utf8').toString('utf8')!==source)fail();
 const tokens=[];let i=0;
 const emit=(k,start)=>{if(tokens.length>=LIMITS.tokens)fail();tokens.push({k,v:source.slice(start,i)});};
 const quoted=(quote,escaped)=>{i++;while(i<source.length){if(escaped&&source[i]==='\\'){i+=2;if(i>source.length)fail();continue;}if(source[i]===quote){i++;if(source[i]===quote){i++;continue;}return;}i++;}fail();};
 while(i<source.length){const start=i,c=source[i];if(white(c)){i++;continue;}
  if(c==='-'&&source[i+1]==='-'){i+=2;while(i<source.length&&source[i]!=='\n'&&source[i]!=='\r')i++;continue;}
  if(c==='/'&&source[i+1]==='*'){i+=2;let depth=1;while(i<source.length&&depth){if(source[i]==='/'&&source[i+1]==='*'){if(++depth>LIMITS.depth)fail();i+=2;}else if(source[i]==='*'&&source[i+1]==='/'){depth--;i+=2;}else i++;}if(depth)fail();continue;}
  if(c==='\''){quoted('\'',false);emit('s',start);continue;}
  if((c==='E'||c==='e')&&source[i+1]==='\''){i++;quoted('\'',true);emit('e',start);continue;}
  if(c==='"'){quoted('"',false);emit('q',start);continue;}
  if(c==='$'){i++;const tagStart=i;if(source[i]!=='$'){if(!letter(source[i])||source[i].charCodeAt(0)>127)fail();while(letter(source[i])||digit(source[i])){if(i-tagStart>=63)fail();i++;}}if(source[i]!=='$')fail();i++;const delimiter=source.slice(start,i),end=source.indexOf(delimiter,i);if(end<0)fail();i=end+delimiter.length;emit('d',start);continue;}
  if(letter(c)){i++;while(letter(source[i])||digit(source[i])||source[i]==='$')i++;emit('w',start);continue;}
  if(digit(c)){i++;while(digit(source[i]))i++;if(source[i]==='.'&&digit(source[i+1])){i++;while(digit(source[i]))i++;}if(source[i]==='e'||source[i]==='E'){i++;if(source[i]==='+'||source[i]==='-')i++;if(!digit(source[i]))fail();while(digit(source[i]))i++;}emit('n',start);continue;}
  if('()[],.;'.includes(c)){i++;emit('p',start);continue;}
  if(':<>=!~^%+-*/|&#?'.includes(c)){i++;while(i<source.length&&':<>=!~^%+-*/|&#?'.includes(source[i]))i++;emit('o',start);if(!OPS.has(tokens[tokens.length-1].v))fail();continue;}
  fail();
 }
 return tokens;
}
function linked(source){
 const t=tokenize(source),pair=new Map(),reverse=new Map(),stack=[],frames=[false];
 for(let i=0;i<t.length;i++){const v=t[i].v;if(t[i].k==='p'&&(v==='('||v==='[')){if(stack.length>=LIMITS.depth)fail();stack.push(i);frames.push(false);}else if(t[i].k==='p'&&(v===')'||v===']')){const start=stack.pop();if(start===undefined||t[start].v!==(v===')'?'(':'['))fail();pair.set(start,i);reverse.set(i,start);frames.pop();}else if(t[i].k==='w'&&t[i].v.toLowerCase()==='select'){if(frames[frames.length-1])fail();frames[frames.length-1]=true;}}
 if(stack.length)fail();
 const word=(i,v)=>t[i]?.k==='w'&&t[i].v.toLowerCase()===v;
 const punct=(i,v)=>t[i]?.k==='p'&&t[i].v===v;
 for(let i=1;i<t.length;i++){
  if(t[i].k==='w'&&FORBIDDEN.has(t[i].v.toLowerCase()))fail();
  if(t[i].k==='p'&&t[i].v===';'&&i!==t.length-1)fail();
  if((t[i].k==='w'||t[i].k==='q')&&punct(i+1,'(')){
   const name=t[i].k==='w'?t[i].v.toLowerCase():null;
   const sourceOpen=reverse.get(i-1);
   const alias=name==='b'&&sourceOpen!==undefined&&word(sourceOpen+1,'values')&&word(i+2,'marca')&&punct(i+3,')')&&word(i+4,'left');
   if(!name||!FUNCTIONS.has(name)&&!CALL_WORDS.has(name)&&!alias)fail();
   if(t[i-1]?.v==='.'&&(t[i-2]?.k!=='w'||t[i-2].v!=='pg_catalog'||!FUNCTIONS.has(name)))fail();
  }
 }
 let i=0;const takeWord=v=>{if(!word(i,v))fail();i++;},takePunct=v=>{if(!punct(i,v))fail();return i++;};
 function selectBody(start,end){if(!word(start,'select'))fail();let from=0;for(let j=start+1;j<end;j++){if(punct(j,'(')||punct(j,'[')){j=pair.get(j);if(j===undefined||j>=end)fail();continue;}if(word(j,'select'))fail();if(word(j,'from'))from++;}if(from!==1)fail();}
 takeWord('with');takeWord('recent');takeWord('as');const rOpen=takePunct('('),rEnd=pair.get(rOpen);if(rEnd===undefined)fail();selectBody(rOpen+1,rEnd);i=rEnd+1;
 takePunct(',');takeWord('brands');takeWord('as');const bOpen=takePunct('('),bEnd=pair.get(bOpen);if(bEnd===undefined)fail();selectBody(bOpen+1,bEnd);i=bEnd+1;
 takeWord('select');takeWord('jsonb_build_object');const call=takePunct('('),callEnd=pair.get(call);if(callEnd===undefined)fail();
 const args=[];let start=call+1;
 for(let j=start;j<callEnd;j++){if(punct(j,'(')||punct(j,'[')){j=pair.get(j);if(j===undefined||j>=callEnd)fail();continue;}if(punct(j,',')){if(start===j)fail();args.push([start,j]);start=j+1;}}
 if(start===callEnd)fail();args.push([start,callEnd]);if(args.length!==KEYS.length*2)fail();
 const seen=new Set();let value=null;
 for(let n=0;n<args.length;n+=2){const [a,z]=args[n];let key=null;if(t[a]?.k==='s'&&z===a+1)key=t[a].v.slice(1,-1);else if(t[a]?.k==='s'&&z===a+3&&t[a+1]?.v==='::'&&word(a+2,'text'))key=t[a].v.slice(1,-1);if(!KEYS.includes(key)||seen.has(key))fail();seen.add(key);if(key==='brands')value=args[n+1];}
 if(!value)fail();i=callEnd+1;takeWord('as');takeWord('payload');takeWord('from');
 // Final FROM is restricted to the one anchor SELECT + original collector join.
 const tailStart=i;if(!punct(i,'('))fail();const tailEnd=pair.get(i);if(tailEnd===undefined)fail();i=tailEnd+1;if(punct(i,';'))i++;if(i!==t.length)fail();
 const tail=t.slice(tailStart,tailEnd+1);
 const expected=['(','(','select','1','as','"?column?"',')','one','left','join','public','.','shrigma_email_consumer_health','h','on','(','(','h','.','key','=',"'ses-events'",'::','text',')',')',')'];
 if(tail.length!==expected.length||tail.some((x,n)=>(x.k==='w'?x.v.toLowerCase():x.v)!==expected[n]))fail();
 return {definition:hash(t),recent:hash(t.slice(rOpen,rEnd+1)),brands:hash(t.slice(bOpen,bEnd+1)),value:hash(t.slice(value[0],value[1]))};
}
function compareHealthViewStructure(source){
 try{const v=linked(source);return Object.freeze({structure_status:'parsed',definition_tokens_sha256:v.definition,recent_cte_tokens_sha256:v.recent,brands_cte_tokens_sha256:v.brands,brands_value_tokens_sha256:v.value,canonical_recent_match:v.recent===CANONICAL.recent,canonical_brands_cte_match:v.brands===CANONICAL.brands,canonical_brands_value_match:v.value===CANONICAL.value});}catch{return UNKNOWN;}
}
module.exports=Object.freeze({compareHealthViewStructure,CANONICAL,LIMITS});
