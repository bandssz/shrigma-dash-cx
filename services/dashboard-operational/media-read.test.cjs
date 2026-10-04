'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function harness(fetchImpl){
 const created=[];
 class Element{
  constructor(tag){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.textContent='';this.events={};created.push(this);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(key,value){this[key]=value;}
  addEventListener(key,fn){this.events[key]=fn;}
  click(){return this.events.click?.();}
 }
 const root=new Element('section'),document={getElementById:id=>id==='crm-media'?root:null,createElement:tag=>new Element(tag)};
 const calls=[];
 const context={document,location:{origin:'https://crm.shrigma.com.br'},URL,URLSearchParams,AbortController,setTimeout,clearTimeout,
  fetch:(...args)=>{calls.push(args);return fetchImpl(...args);},module:{exports:{}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'public/media-read.js'),'utf8'),context);
 const byId=id=>created.find(element=>element.id===id);
 return {media:context.module.exports,root,created,calls,byId};
}
const gate={capabilities:{endpoints:{campaigns_media:'https://crm.shrigma.com.br/api/campaigns_media'}}};
const item=(id,filename)=>({id,filename,content_type:'image/png',width:600,height:400,url:'https://email.shrigma.com.br/uploads/'+filename});
const page=(brand,n,items,next=null)=>({contract:'crm-media-v1',brand,page:n,per_page:24,total:next?48:items.length,items,next_page:next});
const reply=body=>({ok:true,json:async()=>body});

test('media listing is hidden until explicitly advertised and loads metadata only on click',async()=>{
 const h=harness(async()=>reply(page('fish',1,[item(1,'fish.png')])));
 h.media.mount({marca:'fish',api:{}});
 assert.equal(h.byId('crm-media-read-controls').hidden,true);
 assert.equal(h.calls.length,0);
 h.media.mount({marca:'fish',api:gate});
 assert.equal(h.byId('crm-media-read-controls').hidden,false);
 assert.equal(h.calls.length,0);
 await h.byId('crm-media-read-load').click();
 assert.equal(h.calls.length,1);
 const [url,options]=h.calls[0];
 assert.equal(url,'/api/campaigns_media?brand=fish&page=1&per_page=24');
 assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');
 assert.equal(options.headers.Accept,'application/json');
 assert.equal(h.byId('crm-media-read-list').children.length,1);
 assert.equal(h.byId('crm-media-read-list').children[0].children[0].textContent,'fish.png');
 assert.equal(h.created.some(node=>['img','a','input','form'].includes(node.tag)),false);
 assert.equal(h.byId('crm-media-read-status').textContent,'1 arquivo(s) listado(s) para Fishermans. A biblioteca é compartilhada entre as marcas.');
 assert.equal(h.byId('crm-media-read-list').children[0].children.length,2,'resposta antiga sem flag mantém a apresentação');
});

test('pagination and brand changes never mix a stale response with the selected brand',async()=>{
 let releaseFish;
 const fishPending=new Promise(resolve=>{releaseFish=resolve;});
 const h=harness(async url=>{
  if(url.includes('brand=fish'))return fishPending;
  if(url.includes('&page=2&'))return reply(page('aristo',2,[item(3,'aristo-2.png')],null));
  return reply(page('aristo',1,[item(2,'aristo-1.png')],2));
 });
 h.media.mount({marca:'fish',api:gate});
 const fish=h.byId('crm-media-read-load').click();
 h.media.mount({marca:'aristo',api:gate});
 releaseFish(reply(page('fish',1,[item(1,'fish.png')])));
 await fish;
 assert.equal(h.byId('crm-media-read-list').children.length,0);
 await h.byId('crm-media-read-load').click();
 assert.equal(h.byId('crm-media-read-more').hidden,false);
 await h.byId('crm-media-read-more').click();
 assert.equal(h.byId('crm-media-read-more').hidden,true);
 assert.deepEqual(h.byId('crm-media-read-list').children.map(line=>line.children[0].textContent),['aristo-1.png','aristo-2.png']);
 assert.equal(h.calls.length,3);
});

test('unexpected brand and malformed metadata clear the displayed library',async()=>{
 let mode='valid';
 const h=harness(async()=>reply(mode==='brand'?page('aristo',1,[item(2,'other.png')]):mode==='item'?page('fish',1,[item(4,'\u0000unsafe.png')]):page('fish',1,[item(1,'ok.png')])));
 h.media.mount({marca:'fish',api:gate});
 await h.byId('crm-media-read-load').click();
 assert.equal(h.byId('crm-media-read-list').children.length,1);
 mode='brand';
 await h.byId('crm-media-read-load').click();
 assert.equal(h.byId('crm-media-read-list').children.length,0);
 assert.match(h.byId('crm-media-read-status').textContent,/não pôde ser confirmada/);
 mode='item';
 await h.byId('crm-media-read-load').click();
 assert.equal(h.byId('crm-media-read-list').children.length,0);
 h.media.mount({marca:'fish',api:{capabilities:{endpoints:{campaigns_media:'https://evil.invalid/api/campaigns_media'}}}});
 assert.equal(h.byId('crm-media-read-controls').hidden,true);
 assert.equal(h.calls.length,3);
 for(const legacy of ['true',0,null]){
  const bad=harness(async()=>reply(page('fish',1,[{...item(1,'old.png'),legacy}])));bad.media.mount({marca:'fish',api:gate});
  await bad.byId('crm-media-read-load').click();
  assert.equal(bad.byId('crm-media-read-list').children.length,0,'legacy presente precisa ser booleano');
  assert.match(bad.byId('crm-media-read-status').textContent,/não pôde ser confirmada/);
 }
});


test('brand and legacy counts stay separate across pagination and brand change, with text-only labels',async()=>{
 const old={...item(2,'<img src=x>.png'),legacy:true},own=id=>({...item(id,'canonical-'+id+'.png'),legacy:false});
 const h=harness(async url=>reply(url.includes('brand=aristo')?page('aristo',1,[old]):url.includes('&page=2&')?page('fish',2,[old,own(3)]):page('fish',1,[own(1),old],2)));
 h.media.mount({marca:'fish',api:gate});await h.byId('crm-media-read-load').click();
 assert.equal(h.byId('crm-media-read-status').textContent,'1 arquivo(s) da marca Fishermans e 1 arquivo(s) antigo(s) sem marca.');
 assert.equal(h.byId('crm-media-read-list').children[0].children.length,2,'canônico não recebe etiqueta de legado');
 const legacyLine=h.byId('crm-media-read-list').children[1];
 assert.equal(legacyLine.children[0].textContent,'<img src=x>.png');
 assert.equal(legacyLine.children[2].textContent,' · Arquivo antigo (sem marca)');
 await h.byId('crm-media-read-more').click();
 assert.equal(h.byId('crm-media-read-status').textContent,'2 arquivo(s) da marca Fishermans e 1 arquivo(s) antigo(s) sem marca.');
 assert.equal(h.byId('crm-media-read-list').children.length,3,'item repetido na continuação conta uma vez');
 h.media.mount({marca:'aristo',api:gate});await h.byId('crm-media-read-load').click();
 assert.equal(h.byId('crm-media-read-status').textContent,'0 arquivo(s) da marca O Aristocrata e 1 arquivo(s) antigo(s) sem marca.');
 assert.equal(h.byId('crm-media-read-list').children[0].children[2].textContent,' · Arquivo antigo (sem marca)');
 assert.equal(h.calls.length,3);assert.ok(h.calls.every(([,options])=>options.method==='GET'));
 assert.equal(h.created.some(node=>['img','a','input','form'].includes(node.tag)),false);
});
