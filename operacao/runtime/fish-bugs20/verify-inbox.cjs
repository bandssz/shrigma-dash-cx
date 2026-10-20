'use strict';
// Read-only verification of the two messages already obtained through Outlook.
// This does not send email, access credentials, mark mail as read, or claim a CI inbox reader.
const fs=require('node:fs'),a=require('node:assert/strict'),crypto=require('node:crypto');
const raw=fs.readFileSync('/evidence/inbox-277-278.json'),messages=JSON.parse(raw);
a.equal(messages.length,2);
const expected=[
 {brand:'aristo',id:277,domain:'oaristocrata.com',uuid:'5df16f36-1095-4302-9f76-48b81f313b0c',received:'2026-10-20T10:22:04Z'},
 {brand:'fish',id:278,domain:'fishermans.com.br',uuid:'0125ac7b-ccf2-49a0-b181-250b7fce0075',received:'2026-10-20T10:23:38Z'}
];
const results=expected.map(e=>{
 const subject='[TESTE] Teste interno · preop19 sprint13-analyst-20261020-0721 · '+e.brand;
 const found=messages.filter(m=>m.subject===subject);a.equal(found.length,1);
 const m=found[0],body=m.body.content;
 a.equal(m.sender.emailAddress.address,'avisos@'+e.domain);
 a.deepEqual(m.toRecipients.map(r=>r.emailAddress.address),['felipebandeira+codex@oaristocrata.com']);
 a.equal(m.ccRecipients.length,0);a.equal(m.bccRecipients.length,0);
 a.equal(m.receivedDateTime,e.received);a.equal(m.body.contentType,'html');a.equal(m.isRead,false);
 a.match(body,/\[TESTE\] Felipe Codex/);a.equal(body.includes(e.uuid),true);
 a.doesNotMatch(body,/\{\{\s*\.?Subscriber\b/);
 return {brand:e.brand,campaignId:e.id,subject,from:m.sender.emailAddress.address,receivedAt:m.receivedDateTime,onlyInternalRecipient:true,nativeNameRendered:true,campaignUuidMatched:true,rawSubscriberExpression:false,readStateUnchanged:true};
});
console.log(JSON.stringify({schema:'shrigma-existing-test-inbox-proof-v1',ok:true,checkedAt:new Date().toISOString(),readTransport:'Microsoft Outlook native connector',verificationRuntime:'Docker Linux Node22 UID1000; serial; network disabled',ciInboxReaderAvailable:false,captureSha256:crypto.createHash('sha256').update(raw).digest('hex'),newSends:0,businessWrites:0,results},null,2));
