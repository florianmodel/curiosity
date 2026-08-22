// Heartbeat simulator: runs the production developmental prompt against a real
// model with the production tool surface (memory + mocked web), then judges
// whether the turn satisfied the contract.
//
// Usage:
//   OPENAI_API_KEY=sk-... npm run simulate            # cold start
//   SIM_MODEL=gpt-4.1-mini OPENAI_BASE_URL=... npm run simulate
//
// Verdict "PASS": the turn recorded a record_turn with a concrete action.
// Verdict "FAIL": no action (HEARTBEAT_OK-style) or malformed turn report.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevelopmentStore } from "../src/store.ts";
import { renderDevelopmentPrompt } from "../src/prompt.ts";
import { createDevelopmentTool } from "../src/tool.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Turn } from "../src/types.ts";

const BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const MODEL = process.env.SIM_MODEL ?? "gpt-4.1-mini";

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-sim-"));
const store = new DevelopmentStore(workspaceDir);
const memory = createDevelopmentTool(store);

const FAKE_PAGES: Record<string, string> = {
  "https://en.wikipedia.org/wiki/Lighthouse": "<html><head><title>Lighthouse</title></head><body><h1>Lighthouse</h1><p>A lighthouse marks dangerous coastline. Fresnel lenses, invented 1822, multiplied light range. Keepers were made redundant by automation between 1960 and 1990.</p></body></html>",
  "https://en.wikipedia.org/wiki/Fresnel_lens": "<html><head><title>Fresnel lens</title></head><body><p>Fresnel lenses use concentric annular sections to achieve large aperture and short focal length. They float on baths of mercury in rotating assemblies.</p></body></html>",
};

const tools = [
  {
    type: "function",
    function: {
      name: "curiosity_v2",
      description: memory.description,
      parameters: memory.parameters,
    },
  },
];

async function callTool(name: string, args: any): Promise<string> {
  if (name === "curiosity_v2") return (await memory.execute("sim", args)).content[0].text;
  if (name === "curiosity_web_fetch") {
    const url = String(args.url);
    const page = FAKE_PAGES[url];
    if (!page) return JSON.stringify({ error: `no fixture for ${url}; simulator serves only ${Object.keys(FAKE_PAGES).join(", ")}` });
    await store.put("visit", store.id("visit"), { visitId: store.id("visit"), createdAt: Date.now(), kind: "web", location: url });
    return JSON.stringify({ url, title: "fixture", text: page.replace(/<[^>]+>/g, " ").slice(0, 2000) });
  }
  return JSON.stringify({ error: `unknown tool ${name}` });
}

type Message = { role: string; content?: string | null; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] };

async function chat(messages: Message[]): Promise<any> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", max_tokens: 1500 }),
  });
  if (!response.ok) throw new Error(`Model API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message;
}

const snapshot = await store.snapshot();
const messages: Message[] = [
  { role: "system", content: renderDevelopmentPrompt(snapshot, { ...DEFAULT_CONFIG }) },
  { role: "user", content: "A permitted developmental heartbeat begins now." },
];

console.log(`# simulate-heartbeat workspace=${workspaceDir} model=${MODEL}\n`);
for (let step = 0; step < 8; step++) {
  const message: Message = await chat(messages);
  messages.push(message);
  if (!message.tool_calls?.length) {
    console.log(`[final] ${message.content}`);
    break;
  }
  for (const toolCall of message.tool_calls) {
    const args = JSON.parse(toolCall.function.arguments || "{}");
    console.log(`[tool] ${toolCall.function.name} ${JSON.stringify(args).slice(0, 220)}`);
    let result: string;
    try {
      result = await callTool(toolCall.function.name, args);
    } catch (error) {
      result = JSON.stringify({ error: String((error as Error).message ?? error) });
    }
    console.log(`[result] ${result.slice(0, 220)}`);
    messages.push({ role: "tool", content: result, tool_calls: undefined } as never);
  }
}

const finalSnapshot = await store.snapshot();
const turns: Turn[] = finalSnapshot.turns;
const acted = turns.some(turn => turn.action && !turn.blockedReason);
console.log(`\n# verdict`);
console.log(JSON.stringify({
  pass: acted,
  turnsRecorded: turns.length,
  modes: turns.map(turn => turn.mode),
  actions: turns.map(turn => turn.action?.kind),
  blockedReasons: turns.filter(turn => turn.blockedReason).map(turn => turn.blockedReason),
}, null, 2));
process.exit(acted ? 0 : 1);
