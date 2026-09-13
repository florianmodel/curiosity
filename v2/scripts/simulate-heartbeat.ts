// Offline multi-session integration rehearsal. Scripted fixture choices are NOT evidence of curiosity.
// Uses the production tool factory and persistence. No model API or public messages are sent.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {DevelopmentStore} from "../src/store.js";
import {createTools} from "../src/plugin-tools.js";
import {DEFAULT_CONFIG} from "../src/config.js";
import {renderDevelopmentPrompt} from "../src/prompt.js";

const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"curiosity-rehearsal-"));
let store=new DevelopmentStore(workspace);
const steps:Array<{run:string;tool:string;result:unknown}>=[];
function session(runId:string) {
  const tools=createTools({store,config:DEFAULT_CONFIG,workspace,runId:()=>runId,
    readPage:async url=>({url,finalUrl:url,status:200,contentType:"text/html",title:"Fixture: an external observation",links:["https://example.org/follow-up"],totalBytes:50,truncated:false,text:"A fixture observation to test persistence, not to choose the agent's interests."}),
    search:async query=>({query,provider:"wikipedia_api",scope:"Offline fixture",encyclopediaOnly:true,results:[{title:"Fixture observation",url:"https://example.org/observation",snippet:"Test material"}]}),
  });
  return async(name:string,input:Record<string,unknown>)=>{
    const tool=tools.find(tool=>tool.name===name);assert(tool,`Missing production tool ${name}`);
    const text=(await tool.execute(`fixture-${steps.length}`,input)).content[0].text;
    let value;try{value=JSON.parse(text);}catch{value={message:text};}
    steps.push({run:runId,tool:name,result:value});return value;
  };
}
await store.reserveRun("first",{maxRuns:3,maxTokens:10000});
let call=session("first");
await call("curiosity_search",{query:"fixture observation"});
const visit=await call("curiosity_web_fetch",{url:"https://example.org/observation"});
const creation=await call("curiosity_project",{action:"write",project:"rehearsal",path:"notes.md",content:"First observation."});
await call("curiosity_v2",{action:"put_follow_up",record:{followUpId:"return",note:"Revisit fixture observation",target:"https://example.org/follow-up",dueAt:Date.now()-1,state:"pending"}});
await store.recordRunEnd("first",true,100);
await store.close();
store=new DevelopmentStore(workspace);
assert.equal((await store.snapshot()).artifacts.length,1);
assert.equal((await store.snapshot()).visits.length,1);
await store.reserveRun("second",{maxRuns:3,maxTokens:10000});
call=session("second");
const returned=await call("curiosity_web_fetch",{url:"https://example.org/follow-up"});
await call("curiosity_project",{action:"read",project:"rehearsal",path:"notes.md"});
await call("curiosity_project",{action:"write",project:"rehearsal",path:"notes.md",content:"Revised after a later observation.",overwrite:true});
await call("curiosity_v2",{action:"resolve_follow_up",record:{followUpId:"return",state:"completed",evidence:[returned.evidenceId]}});
await store.recordRunEnd("second",true,120);
await store.reserveRun("third",{maxRuns:3,maxTokens:10000});
call=session("third");
await call("curiosity_v2",{action:"record_turn",record:{mode:"reflect",quietReason:"No additional action in this fixture session."}});
await store.recordRunEnd("third",true,25);
const snapshot=await store.snapshot();
assert.equal(snapshot.followUps.length,0);
assert.equal(await fs.readFile(creation.path,"utf8"),"Revised after a later observation.");
assert.equal((await store.event(visit.evidenceId))?.runId,"first");
assert.equal((await store.usage24h()).tokens,245);
await fs.writeFile(path.join(workspace,"rehearsal.json"),JSON.stringify({steps,snapshot},null,2));
await fs.writeFile(path.join(workspace,"next-prompt.md"),renderDevelopmentPrompt(snapshot,DEFAULT_CONFIG));
console.log(JSON.stringify({technicalChecks:"passed",behavioralVerdict:"not evaluated; scripted offline fixture",sessions:3,workspace,trace:path.join(workspace,"rehearsal.json")},null,2));
await store.close();
