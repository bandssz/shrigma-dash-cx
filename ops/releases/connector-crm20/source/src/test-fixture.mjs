import http from 'node:http';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {API_PERMISSIONS} from './listmonk.mjs';
export const fixturePolicy={
  aristo:{listIds:[11],templateIds:[21],fromEmails:['email@oaristocrata.com'],replyToEmails:['contato@oaristocrata.com'],testRecipients:{'qa@shrigma.com.br':31,'inactive@oaristocrata.com':32,'unsub@oaristocrata.com':33}},
  fish:{listIds:[12],templateIds:[22],fromEmails:['email@fishermans.com.br'],replyToEmails:['contato@fishermans.com.br'],testRecipients:{'qa@fishermans.com.br':34}}
};
export function fakeProfile(brand,index=1){const b=fixturePolicy[brand];return{id:100+index,username:'fixture-'+index,type:'api',status:'enabled',password:null,user_role:{id:3,permissions:API_PERMISSIONS},list_role:{id:4,lists:b.listIds.map(id=>({id,permissions:['list:get']}))}};}
export function createFixture({file=null,minNextId=500}={}){
  const campaigns=new Map(),mutations=[],reads=[],profiles=new Map(),templates=new Map([[21,{id:21,name:'Aristo fictício',type:'campaign',body:'<html>{{ template "content" . }}</html>'}],[22,{id:22,name:'Fish fictício',type:'campaign',body:'<html>{{ template "content" . }}</html>'}]]);
  const subscribers=new Map([
    [31,{id:31,email:'qa@shrigma.com.br',status:'enabled',lists:[{id:11,status:'active',subscription_status:'confirmed'}]}],
    [32,{id:32,email:'inactive@oaristocrata.com',status:'blocklisted',lists:[{id:11,status:'active',subscription_status:'confirmed'}]}],
    [33,{id:33,email:'unsub@oaristocrata.com',status:'enabled',lists:[{id:11,status:'active',subscription_status:'unsubscribed'}]}],
    [34,{id:34,email:'qa@fishermans.com.br',status:'enabled',lists:[{id:12,status:'active',subscription_status:'confirmed'}]}]
  ]);
  if(file&&fs.existsSync(file)){
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.schema!=='fictitious-campaigns-v1'||!Array.isArray(saved.campaigns))throw Error('FIXTURE_STATE_REFUSED');
    for(const c of saved.campaigns){if(!Number.isSafeInteger(c.id)||c.id<500||typeof c.uuid!=='string')throw Error('FIXTURE_STATE_REFUSED');campaigns.set(c.id,c);}
  }
  let id=Math.max(500,minNextId,...[...campaigns.keys()].map(n=>n+1));
  const persist=()=>{if(file){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify({schema:'fictitious-campaigns-v1',campaigns:[...campaigns.values()]}),{mode:0o600});fs.renameSync(temp,file);}};
  const state={campaigns,mutations,reads,profiles,templates,subscribers,failNext:null,ignoreUpdate:false,afterMutation:null};
  const handler=async(req,res)=>{
    try{
      const url=new URL(req.url,'http://fixture'),route=url.pathname,method=req.method;
      const basic=req.headers.authorization?.replace(/^Basic /,'');const username=basic?Buffer.from(basic,'base64').toString().split(':')[0]:'';
      const profile=profiles.get(username);if(!profile){res.writeHead(401);res.end();return;}
      let raw='';for await(const c of req){raw+=c;if(raw.length>600000)throw Error('LIMIT');}const body=raw?JSON.parse(raw):null;
      if(method==='GET')reads.push(route);else mutations.push({method,route,body:structuredClone(body),username});
      let data;
      if(method==='GET'&&route==='/api/profile')data=profile;
      else if(method==='GET'&&/^\/api\/lists\/\d+$/.test(route)){const n=Number(route.split('/').at(-1));data={id:n,name:n===11?'Aristo fictício':'Fish fictício',status:'active',subscriber_count:7};}
      else if(method==='GET'&&/^\/api\/templates\/\d+$/.test(route))data=templates.get(Number(route.split('/').at(-1)));
      else if(method==='GET'&&/^\/api\/subscribers\/\d+$/.test(route))data=subscribers.get(Number(route.split('/').at(-1)));
      else if(method==='GET'&&route==='/api/campaigns'){const results=[...campaigns.values()].filter(c=>c.tags?.includes(url.searchParams.get('tag')));data={results:results.slice(0,2),total:results.length};}
      else if(method==='POST'&&route==='/api/campaigns'){data={...body,id:id++,uuid:randomUUID(),status:'draft',created_at:new Date().toISOString(),media:[],sent:0,to_send:7};campaigns.set(data.id,data);}
      else if(/^\/api\/campaigns\/\d+/.test(route)){
        const n=Number(route.split('/')[3]),c=campaigns.get(n);if(!c){res.writeHead(404);res.end();return;}
        if(method==='GET')data=c;
        else if(method==='POST'&&route.endsWith('/test'))data=true;
        else if(method==='PUT'&&route.endsWith('/status')){c.status=body.status;data=c;}
        else if(method==='PUT'){if(!state.ignoreUpdate)Object.assign(c,body);data=c;}
        else throw Error('ROUTE');
      }else throw Error('ROUTE');
      if(data===undefined){res.writeHead(404);res.end();return;}
      if(method!=='GET')persist();
      if(method!=='GET'&&state.afterMutation){const cb=state.afterMutation;state.afterMutation=null;await cb(data);}
      if(state.failNext===method){state.failNext=null;req.socket.destroy();return;}
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data}));
    }catch{if(!res.headersSent)res.writeHead(500);res.end();}
  };
  return{...state,state,handler,listen:async()=>{const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,origin:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};}};
}
