/* Native Listmonk v6.1 transport. request is a credentialed server-side adapter.
   Only draft creation and no-send previews are exposed here. */
'use strict';
function createNative({request}){
 if(typeof request!=='function')throw Error('Native Listmonk transport required');
 const html=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 return {
  async nativeCreate(payload){
   if(payload.send_at!==null||payload.type!=='regular')throw Object.assign(Error('Draft creation must be unscheduled'),{nothingChanged:true});
   const r=await request({method:'POST',path:'/api/campaigns',json:payload,responseType:'json'});
   if(!r||![200,201].includes(r.status)||!Number.isSafeInteger(r.body?.data?.id)||r.body.data.id<=0)throw Error('Native draft creation unconfirmed');
   return r.body.data;
  },
  async validateContent({id,definition,templateVersion}){
   if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid campaign identity');
   // Separate compilations prevent an unclosed Go expression in one field from
   // being accidentally closed by another field. The wrapper is compiled each time.
   for(const [field,body] of [['html',definition.html],['subject',html(definition.subject)],['text',html(definition.text)]]){
    const r=await request({method:'POST',path:`/api/campaigns/${id}/preview`,form:{content_type:'html',template_id:String(definition.template_id),body},responseType:'text'});
    if(!r||r.status!==200||typeof r.body!=='string'||!r.body.trim())return {ok:false,field};
   }
   return {ok:true,templateVersion};
  }
 };
}
module.exports={createNative};
