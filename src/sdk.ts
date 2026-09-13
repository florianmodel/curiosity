/** Narrow structural contract verified against the local OpenClaw public hook types.
 * No core imports at runtime. Unknown fields remain unknown instead of bypassing checks with any.
 */
export type Context = {runId?:string;agentId?:string;sessionKey?:string;sessionId?:string;workspaceDir?:string;trigger?:string};
export type ToolContext = Omit<Context,"runId"|"trigger">;
export type ToolResult = {content:Array<{type:string;text:string}>;isError?:boolean};
export type Tool = {name:string;label?:string;description:string;parameters:object;execute:(callId:string,input:Record<string,unknown>)=>Promise<ToolResult>};
export type HookMap = {
  before_prompt_build:(event:{prompt:string;messages:unknown[]},ctx:Context)=>Promise<{prependContext:string}|undefined>;
  before_tool_call:(event:{toolName:string;params:Record<string,unknown>;runId?:string;toolCallId?:string},ctx:Context & {toolName:string;toolCallId?:string})=>Promise<{block?:boolean;blockReason?:string}|undefined>;
  after_tool_call:(event:{toolName:string;params:Record<string,unknown>;runId?:string;toolCallId?:string;result?:unknown;error?:string},ctx:Context & {toolName:string;toolCallId?:string})=>Promise<void>;
  llm_output:(event:{runId:string;usage?:{total?:number;input?:number;output?:number;cacheRead?:number;cacheWrite?:number}},ctx:Context)=>Promise<void>;
  agent_end:(event:{success:boolean;error?:string;messages?:unknown[]},ctx:Context)=>Promise<void>;
};
export type PluginApi = {
  pluginConfig?:Record<string,unknown>;config:Record<string,unknown>;
  runtime:{system?:{requestHeartbeatNow?:(params:{reason:string;agentId?:string;sessionKey?:string})=>void}};
  logger?:{warn:(message:string)=>void};
  registerTool:(factory:(ctx:ToolContext)=>Tool[]|Tool|null,options:{names?:string[];name?:string;optional?:boolean})=>void;
  registerService:(service:{id:string;start:()=>void|Promise<void>;stop:()=>void|Promise<void>})=>void;
  on:<K extends keyof HookMap>(name:K,handler:HookMap[K])=>void;
};
