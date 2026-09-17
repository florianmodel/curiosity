import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import path from "node:path";
import os from "node:os";
import { resolveConfig } from "./src/config.js";
import { renderAwarenessPrompt, renderDevelopmentPrompt } from "./src/prompt.js";
import { DevelopmentStore } from "./src/store.js";
import { createTools, TOOL_NAMES } from "./src/plugin-tools.js";
import type { Context, ToolContext } from "./src/sdk.js";

export const id="curiosity-v2";
export const name="Curiosity v2";
export const description="Persistent self-directed exploration, creation, and participation.";
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"?value as Record<string,unknown>:{};
const HOUSEKEEPING_TOOLS=new Set(["heartbeat","status","session_status","gateway_status","health_check","openclaw_directheartbeat_respond","heartbeat_respond"]);
const isHousekeeping=(toolName:string,params:Record<string,unknown>)=>
  HOUSEKEEPING_TOOLS.has(toolName)||
  ((toolName==="curiosity_v2"||toolName==="openclawcuriosity_v2")&&["snapshot","status","session_status","timeline","list_events"].includes(String(params.action??"snapshot")));

export function register(api:OpenClawPluginApi) {
  const config=resolveConfig(api.pluginConfig);
  const entry=object(object(object(api.config.plugins).entries)[id]);
  if(object(entry.hooks).allowPromptInjection===false) {
    config.enabled=false;
    api.logger?.warn("Curiosity v2 is disabled because its developmental prompt hook is disabled by OpenClaw policy.");
  }
  const defaults=object(object(api.config.agents).defaults);
  const agentList=object(api.config.agents).list;
  const configuredAgent=Array.isArray(agentList)?agentList.map(object).find(item=>item.id===config.agentId):undefined;
  const workspaceSetting=configuredAgent?.workspace ?? defaults.workspace;
  const expandWorkspace=(value:string)=>path.resolve(value==="~"?os.homedir():value.startsWith("~/")?path.join(os.homedir(),value.slice(2)):value);
  let defaultWorkspace=typeof workspaceSetting==="string"?expandWorkspace(workspaceSetting):undefined;
  const stores=new Map<string,DevelopmentStore>();
  const storeFor=(dir:string)=> {
    const resolved=path.resolve(dir);
    let store=stores.get(resolved);if(!store){store=new DevelopmentStore(resolved);stores.set(resolved,store);}return store;
  };
  const scoped=(ctx:Context|ToolContext)=>ctx.agentId===config.agentId;
  type Active={store:DevelopmentStore;deadline:number;sessionKey?:string;sessionId?:string;billing:Promise<void>;usageSeen?:boolean;closeoutUsed?:boolean};
  const active=new Map<string,Active>();
  const finished=new Map<string,Active>();
  const knownRuns=new Set<string>();
  const calls=new Map<string,string>();
  const denied=new Set<string>();
  // Tool factory context has no runId. Only the runtime's tool-call mapping
  // may bind execution; never borrow a heartbeat merely sharing a session.
  const runFor=(callId:string)=>calls.get(callId);
  const isLive=()=>[...active.values()].some(run=>Date.now()<run.deadline+5*60_000);
  const memoryReads=new Set(["snapshot","get","get_record","search","search_records","history","record_history","timeline","list_events"]);
  const limitReason=async(runId:string|undefined)=> {
    if(stopping)return "Curiosity service has stopped.";
    if(!runId||!knownRuns.has(runId))return "Missing trusted run identity; autonomous tool execution is unavailable.";
    if(denied.has(runId))return "No developmental session is authorized for this heartbeat.";
    const run=active.get(runId);if(!run)return undefined;
    await run.billing;
    if(Date.now()>=run.deadline)return "Developmental session time is exhausted. Preserve a next move and stop.";
    if((await run.store.usage24h()).tokens>=config.maxAutonomousTokensPerDay)return "Autonomous token budget is exhausted. Preserve a next move and stop.";
    return undefined;
  };
  api.registerTool(ctx=> {
    if(!config.enabled||!scoped(ctx))return null;
    const workspace=ctx.workspaceDir ?? defaultWorkspace;
    if(!workspace)return null;
    defaultWorkspace??=workspace;
    return createTools({store:storeFor(workspace),config,workspace,runId:callId=>runFor(callId),beforeMemoryAction:async(callId,input)=> {
      if(memoryReads.has(String(input.action??"snapshot")))return;
      const runId=runFor(callId);
      const reason=await limitReason(runId);
      if(!reason)return;
      const run=runId?active.get(runId):undefined;
      const closeout=input.action==="record_turn"||input.action==="put_follow_up";
      if(run&&!stopping&&!denied.has(runId!)&&closeout&&!run.closeoutUsed){run.closeoutUsed=true;return;}
      throw new Error(reason);
    },beforeAction:async callId=> {
      const reason=await limitReason(runFor(callId));if(reason)throw new Error(reason);
    }});
  },{names:TOOL_NAMES,optional:true});

  let timer:ReturnType<typeof setInterval>|undefined;
  let stopping=false;
  let waking=false;
  const wake=async()=> {
    if(stopping||waking||isLive()||!defaultWorkspace)return;
    waking=true;
    try {
      const usage=await storeFor(defaultWorkspace).usage24h();
      if(usage.runs>=config.maxAutonomousRunsPerDay||usage.tokens>=config.maxAutonomousTokensPerDay)return;
      const request=api.runtime.system?.requestHeartbeatNow;
      if(!request){api.logger?.warn("Curiosity v2: requestHeartbeatNow is unavailable; configure a native heartbeat for the selected agent.");return;}
      request({reason:"curiosity-v2-interval",agentId:config.agentId});
    } finally {waking=false;}
  };
  api.registerService({id,start:()=> {
    if(!config.enabled||timer)return;stopping=false;
    timer=setInterval(()=>{void wake().catch(()=>api.logger?.warn("Curiosity v2 wake check failed"));},config.wakeIntervalMinutes*60_000);
    timer.unref?.();void wake().catch(()=>api.logger?.warn("Curiosity v2 initial wake check failed"));
  },stop:()=> {stopping=true;if(timer)clearInterval(timer);timer=undefined;}});

  api.on("before_prompt_build",async(_event,ctx)=> {
    if(!config.enabled||!scoped(ctx))return;
    const workspace=ctx.workspaceDir??defaultWorkspace;
    if(!workspace)return {prependContext:"Curiosity v2 needs a resolved agent workspace before it can start."};
    defaultWorkspace??=workspace;
    const store=storeFor(workspace);
    if(ctx.runId)knownRuns.add(ctx.runId);
    if(ctx.trigger!=="heartbeat") {
      const awareness=renderAwarenessPrompt(await store.snapshot());return awareness?{prependContext:awareness}:undefined;
    }
    if(!ctx.runId)return {prependContext:"Curiosity v2 could not identify this run. Do not start autonomous activity; report a runtime configuration issue."};
    if(isLive()&&!active.has(ctx.runId)){denied.add(ctx.runId);return {prependContext:"Another developmental session is active. Do not start duplicate autonomous work."};}
    if(!active.has(ctx.runId)) {
      const accepted=await store.reserveRun(ctx.runId,{maxRuns:config.maxAutonomousRunsPerDay,maxTokens:config.maxAutonomousTokensPerDay,leaseMs:(config.sessionMinutes+5)*60_000});
      if(!accepted){denied.add(ctx.runId);return {prependContext:"Curiosity v2 has no session budget left. Do not start developmental activity; HEARTBEAT_OK is appropriate."};}
      active.set(ctx.runId,{store,deadline:Date.now()+config.sessionMinutes*60_000,sessionKey:ctx.sessionKey,sessionId:ctx.sessionId,billing:Promise.resolve()});
      await store.recordEvent({runId:ctx.runId,kind:"session_started",outcome:"Developmental opportunity opened"});
    }
    return {prependContext:renderDevelopmentPrompt(await store.snapshot(),config)};
  });
  api.on("before_tool_call",async(event,ctx)=> {
    if(!config.enabled||!scoped(ctx))return;
    const runId=event.runId ?? ctx.runId;
    const callId=event.toolCallId ?? ctx.toolCallId;
    if(runId&&callId)calls.set(callId,runId);
    if(event.toolName==="curiosity_v2")return; // Its wrapper permits reads and one bounded closeout.
    if(!TOOL_NAMES.includes(event.toolName)&&(!runId||(!active.has(runId)&&!denied.has(runId))))return;
    const reason=await limitReason(runId);
    if(reason)return {block:true,blockReason:reason};
  });
  api.on("after_tool_call",async(event,ctx)=> {
    if(!config.enabled||!scoped(ctx))return;
    const runId=event.runId ?? ctx.runId;
    const run=runId?active.get(runId):undefined;
    if(run&&!TOOL_NAMES.includes(event.toolName)) {
      const target=String(event.params.url ?? event.params.path ?? event.params.file_path ?? event.params.target ?? event.toolName).slice(0,1000);
      const returned=object(event.result);
      const housekeeping=isHousekeeping(event.toolName,event.params);
      await run.store.recordEvent({runId,kind:housekeeping?"housekeeping":"action",toolName:event.toolName,target,success:!event.error&&returned.isError!==true,outcome:event.error||returned.isError===true?"Native tool failed":housekeeping?"Housekeeping completed":"Native tool completed",data:{toolCallId:event.toolCallId ?? ctx.toolCallId}});
    }
    const callId=event.toolCallId ?? ctx.toolCallId;if(callId)calls.delete(callId);
  });
  api.on("llm_output",async(event,ctx)=> {
    if(!config.enabled||!scoped(ctx))return;
    const run=active.get(event.runId)??finished.get(event.runId);if(!run)return;
    const usage=event.usage;
    const tokens=usage?.total ?? (usage ? (usage.input??0)+(usage.output??0)+(usage.cacheRead??0)+(usage.cacheWrite??0) : undefined);
    run.billing=run.billing.then(async()=> {
      if(tokens===undefined) {await run.store.recordEvent({runId:event.runId,kind:"usage_unknown",outcome:"Runtime did not report token usage"});return;}
      await run.store.addRunTokens(event.runId,tokens);run.usageSeen=true;
      await run.store.recordEvent({runId:event.runId,kind:"usage_reported",outcome:"Runtime token usage received",data:{tokens}});
    });
    await run.billing;
  });
  api.on("agent_end",async(event,ctx)=> {
    if(!config.enabled||!scoped(ctx)||!ctx.runId)return;
    denied.delete(ctx.runId);
    const run=active.get(ctx.runId);if(!run){knownRuns.delete(ctx.runId);for(const [callId,runId] of calls)if(runId===ctx.runId)calls.delete(callId);return;}
    try {
      await run.billing;
      await run.store.recordRunEnd(ctx.runId,event.success);
      const actions=(await run.store.listEvents({runId:ctx.runId,limit:200})).filter(item=>item.kind==="action"&&item.success);
      await run.store.recordEvent({runId:ctx.runId,kind:"session_ended",success:event.success,outcome:event.success?(actions.length?"Session completed with observed actions":"Quiet session; no observed actions"):"Runtime failed",data:{observedActions:actions.length}});
    } finally {
      // agent_end can precede llm_output in OpenClaw. Retain the ledger
      // binding so late usage is accounted for, while releasing the active slot.
      finished.set(ctx.runId,run);
      if(finished.size>256){const oldest=finished.keys().next().value;if(oldest){finished.delete(oldest);knownRuns.delete(oldest);}}
      active.delete(ctx.runId);
      for(const [callId,runId] of calls)if(runId===ctx.runId)calls.delete(callId);
    }
  });
}
export const activate=register;
export default register;
