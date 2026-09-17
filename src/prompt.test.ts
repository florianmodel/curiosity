import {describe,expect,it} from "vitest";
import {DEFAULT_CONFIG} from "./config.js";
import {renderDevelopmentPrompt,renderAwarenessPrompt} from "./prompt.js";
import type {Snapshot} from "./types.js";
const empty:Snapshot={interests:[],projects:[],recentExperiences:[],relationships:[],artifacts:[],resourceRequests:[],selfModifications:[],turns:[],visits:[],dueHooks:[]};
describe("development prompt",()=>{
  it("keeps the experiment open-ended with honest quiet sessions and standing boundaries",()=>{
    const prompt=renderDevelopmentPrompt(empty,DEFAULT_CONFIG);
    expect(prompt).toContain("no artifact quota");expect(prompt).toContain("attempt at least one genuine outward or constructive action");
    expect(prompt).toContain("quietReason");expect(prompt).toContain("Economic stage 0");expect(prompt).toContain("credential isolation");
    expect(prompt).not.toContain("propose exactly three");expect(prompt).not.toMatch(/build a (website|game)/i);
  });
  it("requires a constructive attempt while allowing honest blockage",()=>{
    const prompt=renderDevelopmentPrompt(empty,DEFAULT_CONFIG);
    expect(prompt).toContain("Do not end with only snapshot/status inspection");
    expect(prompt).toContain("only when every available route is unavailable, unsafe, or genuinely unproductive");
    expect(prompt).toContain("HEARTBEAT_OK is appropriate only after an honest action");
  });
  it("does not advertise disabled plugin capabilities or unconfigured Mastodon",()=>{
    const prompt=renderDevelopmentPrompt(empty,{...DEFAULT_CONFIG,allowWebFetch:false,allowNotes:false,allowSearch:false,allowProjects:false});
    for(const tool of ["curiosity_web_fetch","curiosity_note_write","curiosity_search","curiosity_project","curiosity_social"])expect(prompt).not.toContain(tool);
    expect(prompt).toContain("Mastodon is not configured");expect(prompt).toContain("tools actually listed");
  });
  it("still offers outward discovery after an initial quiet or blocked turn",()=>{
    expect(renderDevelopmentPrompt({...empty,turns:[{turnId:"quiet",createdAt:1,mode:"reflect",quietReason:"Nothing yet"}]},DEFAULT_CONFIG)).toContain("no established interests");
  });
  it("recalls due hooks and hints without mandating that they be pursued",()=>{
    const prompt=renderDevelopmentPrompt({...empty,dueHooks:[{refId:"old",kind:"interest",name:"Tide pools",dueAt:1,hint:"why do they drift?"}]},DEFAULT_CONFIG);
    expect(prompt).toContain("Tide pools");expect(prompt).toContain("why do they drift?");expect(prompt).toContain("genuinely unproductive");
  });
  it("keeps ordinary user-task awareness compact",()=>{
    expect(renderAwarenessPrompt(empty)).toBeUndefined();
    const interest={interestId:"i",name:"Clocks",currentUnderstanding:"x".repeat(10000)} as Snapshot["interests"][number];
    const context=renderAwarenessPrompt({...empty,interests:[interest]});expect(context?.length).toBeLessThan(800);
  });
});
