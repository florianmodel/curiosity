import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {register} from "./index.js";
import type {PluginApi,HookMap,Tool,ToolContext} from "./src/sdk.js";
import {DevelopmentStore} from "./src/store.js";

const dirs:string[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(dirs.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});
async function setup(extra:Record<string,unknown>={}) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),"curiosity-runtime-"));dirs.push(workspace);
  const hooks:Partial<HookMap>={};let factory:((ctx:ToolContext)=>Tool|Tool[]|null)|undefined;
  let service:{start:()=>void|Promise<void>;stop:()=>void|Promise<void>}|undefined;
  const wake=vi.fn();
  const api:PluginApi={config:{agents:{defaults:{workspace}}},pluginConfig:{...extra},runtime:{system:{requestHeartbeatNow:wake}},
    registerTool:(fn)=>{factory=fn;},registerService:s=>{service=s;},on:(name,fn)=>{(hooks as Record<string,unknown>)[name]=fn;}};
  register(api);
  const ctx={agentId:"main",workspaceDir:workspace,sessionKey:"agent:main:main",runId:"run-one",trigger:"heartbeat"};
  const store=new DevelopmentStore(workspace);
  const tools=()=>factory!(ctx) as Tool[];
  const call=async(name:string,input:Record<string,unknown>,run=ctx)=> {
    const toolCallId=`call-${Math.random()}`;
    const blocked=await hooks.before_tool_call!({toolName:name,params:input,toolCallId,runId:run.runId},{...run,toolName:name});
    if(blocked?.block)throw new Error(blocked.blockReason);
    const output=await tools().find(tool=>tool.name===name)!.execute(toolCallId,input);
    await hooks.after_tool_call!({toolName:name,params:input,result:output,toolCallId,runId:run.runId},{...run,toolName:name});
    return JSON.parse(output.content[0].text);
  };
  return {workspace,hooks,ctx,store,tools,call,wake,service:()=>service!,factory:()=>factory!};
}

describe("developmental runtime",()=> {
  it("binds observed tool evidence to a real heartbeat and preserves it after restart",async()=> {
    const h=await setup();
    const prompt=await h.hooks.before_prompt_build!({prompt:"heartbeat",messages:[]},h.ctx);
    expect(prompt?.prependContext).toContain("no artifact quota");
    const written=await h.call("curiosity_note_write",{slug:"experiment",content:"A real creation"});
    const snapshot=await h.store.snapshot();
    expect(snapshot.artifacts[0].location).toBe(written.path);
    expect(snapshot.events.find(event=>event.eventId===written.evidenceId)?.runId).toBe(h.ctx.runId);
    await h.hooks.llm_output!({runId:h.ctx.runId,usage:{total:123}},h.ctx);
    await h.hooks.agent_end!({success:true},h.ctx);
    expect(await h.store.usage24h()).toEqual({runs:1,tokens:123});
    await h.store.close();
    const next=new DevelopmentStore(h.workspace);
    expect((await next.snapshot()).artifacts).toHaveLength(1);await next.close();
  });
  it("counts consumed tokens on failures and blocks further tool work when exhausted",async()=> {
    const h=await setup({maxAutonomousTokensPerDay:100});
    await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
    await h.hooks.llm_output!({runId:h.ctx.runId,usage:{total:101}},h.ctx);
    await expect(h.call("curiosity_note_write",{slug:"late",content:"x"})).rejects.toThrow(/budget/);
    await h.hooks.agent_end!({success:false},h.ctx);
    expect(await h.store.usage24h()).toEqual({runs:0,tokens:101});await h.store.close();
  });
  it("does not reserve another run for repeated prompt construction or overlapping heartbeats",async()=> {
    const h=await setup();
    await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
    await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
    expect((await h.store.usage24h()).runs).toBe(1);
    const other={...h.ctx,runId:"run-two"};
    expect((await h.hooks.before_prompt_build!({prompt:"",messages:[]},other))?.prependContext).toContain("Another");
    await expect(h.call("curiosity_note_write",{slug:"duplicate",content:"x"},other)).rejects.toThrow(/authorized/);
    await h.hooks.agent_end!({success:true},h.ctx);await h.store.close();
  });
  it("enforces the session deadline while leaving memory available for a next move",async()=> {
    vi.useFakeTimers();
    const h=await setup({sessionMinutes:1});
    await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
    vi.setSystemTime(Date.now()+61_000);
    await expect(h.call("curiosity_project",{action:"list",project:"late"})).rejects.toThrow(/time/);
    await expect(h.call("curiosity_v2",{action:"snapshot"})).resolves.toBeDefined();
    await h.hooks.agent_end!({success:true},h.ctx);await h.store.close();
  });
  it("does not register tools or inject curiosity into another agent",async()=> {
    const h=await setup();
    expect(h.factory()({...h.ctx,agentId:"other"})).toBeNull();
    expect(await h.hooks.before_prompt_build!({prompt:"",messages:[]},{...h.ctx,agentId:"other"})).toBeUndefined();await h.store.close();
  });
  it("scopes its wake to the configured agent",async()=> {
    const h=await setup();h.service().start();
    await vi.waitFor(()=>expect(h.wake).toHaveBeenCalledWith({reason:"curiosity-v2-interval",agentId:"main"}));
    h.service().stop();await h.store.close();
  });
  it("records native action evidence without copying potentially sensitive tool output",async()=> {
    const h=await setup();await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
    await h.hooks.after_tool_call!({toolName:"exec",params:{command:"echo secret"},result:{content:[{text:"private-secret"}]},runId:h.ctx.runId},{...h.ctx,toolName:"exec"});
    const event=(await h.store.listEvents()).find(item=>item.toolName==="exec");
    expect(event?.success).toBe(true);expect(JSON.stringify(event)).not.toContain("private-secret");
    await h.hooks.agent_end!({success:true},h.ctx);await h.store.close();
  });
});

it("accounts for usage emitted after agent_end by the real hook order",async()=>{
  const h=await setup();await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
  await h.hooks.agent_end!({success:true},h.ctx);
  await h.hooks.llm_output!({runId:h.ctx.runId,usage:{total:321}},h.ctx);
  expect(await h.store.usage24h()).toEqual({runs:1,tokens:321});await h.store.close();
});
it("does not borrow a session's heartbeat identity for an unmapped tool call",async()=>{
  const h=await setup();await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);
  const tool=h.tools().find(item=>item.name==="curiosity_note_write")!;
  await expect(tool.execute("no-hook-binding",{slug:"wrong",content:"wrong"})).rejects.toThrow(/identity/);
  const user={...h.ctx,runId:"user-run",trigger:"user"};
  await h.hooks.before_prompt_build!({prompt:"",messages:[]},user);
  const output=await h.call("curiosity_note_write",{slug:"user-work",content:"user initiated"},user);
  expect((await h.store.event(output.evidenceId))?.runId).toBe("user-run");
  await h.hooks.agent_end!({success:true},h.ctx);await h.store.close();
});
it("blocks memory mutations after the deadline except for one closeout",async()=>{
  vi.useFakeTimers();const h=await setup({sessionMinutes:1});
  await h.hooks.before_prompt_build!({prompt:"",messages:[]},h.ctx);vi.setSystemTime(Date.now()+61000);
  await expect(h.call("curiosity_v2",{action:"put_project",record:{name:"not now"}})).rejects.toThrow(/time/);
  const callId="closeout";
  await h.hooks.before_tool_call!({toolName:"curiosity_v2",params:{},runId:h.ctx.runId,toolCallId:callId},{...h.ctx,toolName:"curiosity_v2"});
  const memory=h.tools().find(item=>item.name==="curiosity_v2")!;
  await expect(memory.execute(callId,{action:"record_turn",record:{mode:"reflect",quietReason:"Stopping here"}})).resolves.toBeDefined();
  await expect(memory.execute(callId,{action:"record_turn",record:{mode:"reflect",quietReason:"Again"}})).rejects.toThrow(/time/);
  await h.hooks.agent_end!({success:true},h.ctx);await h.store.close();
});
