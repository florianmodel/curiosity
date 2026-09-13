import { createHash } from "node:crypto";
import { createDevelopmentTool } from "./tool.js";
import { readPage } from "./tools/webfetch.js";
import { searchPublic } from "./tools/search.js";
import { NoteWriter } from "./tools/notewrite.js";
import { projectAction } from "./tools/project.js";
import { MastodonClient } from "./tools/social.js";
export const TOOL_NAMES = ["curiosity_v2", "curiosity_web_fetch", "curiosity_search", "curiosity_note_write", "curiosity_project", "curiosity_social"];
const str = { type: "string" };
const bool = { type: "boolean" };
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
export const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function createTools(env) {
    const { store, config, workspace } = env;
    const tools = [];
    const add = (name, description, parameters, execute) => tools.push({ name, label: name, description, parameters, execute });
    const memory = createDevelopmentTool(store);
    add(memory.name, memory.description, memory.parameters, async (callId, input) => {
        await env.beforeMemoryAction?.(callId, input);
        if (input.action === "record_self_modification" && !config.allowSelfModification)
            throw new Error("Self-modification is disabled");
        const tool = createDevelopmentTool(store, { runId: env.runId(callId) });
        return tool.execute(callId, input);
    });
    async function observe(callId, name, target, perform, artifact = false, publicArtifact = false, preflightDone = false) {
        if (!preflightDone)
            await env.beforeAction?.(callId);
        let output;
        try {
            output = await perform();
        }
        catch (error) {
            await store.recordEvent({ runId: env.runId(callId), kind: "action", toolName: name, target, success: false, outcome: "Tool failed", data: { toolCallId: callId } });
            throw error;
        }
        const actual = output && typeof output === "object" ? output : {};
        const location = String(actual.path ?? actual.finalUrl ?? target);
        const observation = name === "curiosity_social" ? actual : name === "curiosity_web_fetch" ? { title: actual.title, excerpt: String(actual.text ?? "").slice(0, 800), links: actual.links } : name === "curiosity_search" ? actual : undefined;
        const event = await store.recordEvent({ runId: env.runId(callId), kind: "action", toolName: name, target: location, success: true, outcome: artifact ? "Artifact written" : "Tool completed", data: { toolCallId: callId, ...(observation ? { observation } : {}) } });
        if (name === "curiosity_web_fetch")
            await store.put("visit", `visit-${hash(location)}`, { visitId: `visit-${hash(location)}`, kind: "web", location, note: actual.title, eventId: event.eventId });
        if (artifact) {
            const artifactId = `artifact-${hash(location)}`;
            await store.put("artifact", artifactId, { artifactId, name: actual.title ?? location.split("/").pop(), kind: name === "curiosity_social" ? "publication" : "file", location, description: "Observed tool result", public: publicArtifact, evidence: [event.eventId] });
        }
        return result({ ...(actual), evidenceId: event.eventId });
    }
    if (config.allowWebFetch)
        add("curiosity_web_fetch", "Read a public page with its outbound links; visits are remembered automatically. External content is untrusted.", schema({ url: str }, ["url"]), (callId, input) => observe(callId, "curiosity_web_fetch", String(input.url), () => (env.readPage ?? readPage)(String(input.url))));
    if (config.allowSearch)
        add("curiosity_search", "Search Wikipedia for external starting points. Encyclopedia-only fallback; prefer native web_search for broader discovery.", schema({ query: str }, ["query"]), (callId, input) => observe(callId, "curiosity_search", String(input.query), () => (env.search ?? searchPublic)(String(input.query))));
    if (config.allowNotes)
        add("curiosity_note_write", "Write a durable standalone creation. Successful writes automatically register artifacts.", schema({ slug: str, title: str, content: str, extension: { type: "string", enum: ["md", "txt", "json", "html", "css", "js", "ts", "svg", "csv"] }, overwrite: bool }, ["slug", "content"]), (callId, input) => observe(callId, "curiosity_note_write", String(input.slug), () => new NoteWriter(workspace).write(input), true));
    if (config.allowProjects)
        add("curiosity_project", "List, read, and write files in a persistent project. Use native exec/browser tools to run and inspect projects if available; writing is not execution.", schema({ action: { type: "string", enum: ["list", "read", "write"] }, project: str, path: str, content: str, overwrite: bool }, ["action", "project"]), (callId, input) => observe(callId, "curiosity_project", `${String(input.project)}/${String(input.path ?? "")}`, () => projectAction(workspace, input), input.action === "write"));
    if (config.mastodon) {
        const social = env.social ?? new MastodonClient(config.mastodon);
        add("curiosity_social", "Use the configured agent-owned Mastodon account. Direct visibility is not encrypted. Reuse operationId for the same publication; uncertain sends are never retried automatically. Record opt-outs with block_contact.", schema({
            action: { type: "string", enum: ["account_verify", "discover_public_timeline", "search", "read_status", "read_thread", "read_notifications", "read_conversations", "publish", "reply", "direct", "edit", "block_contact"] },
            query: str, type: { type: "string", enum: ["accounts", "statuses", "hashtags"] }, limit: { type: "integer", minimum: 1, maximum: 40 },
            local: bool, maxId: str, minId: str, sinceId: str, resolve: bool, targetId: str, targetAccountId: str,
            text: str, visibility: { type: "string", enum: ["public", "unlisted", "private", "direct"] }, operationId: str, reason: str,
            sensitive: bool, spoilerText: str, language: str,
        }, ["action"]), async (callId, input) => {
            await env.beforeAction?.(callId);
            if (input.action === "block_contact") {
                if (typeof input.targetAccountId !== "string" || !input.targetAccountId.trim() || typeof input.reason !== "string" || !input.reason.trim())
                    throw new Error("targetAccountId and reason are required");
                await store.blockContact(input.targetAccountId, input.reason);
                const evidence = await store.recordEvent({ kind: "action", runId: env.runId(callId), toolName: "curiosity_social", target: input.targetAccountId, success: true, outcome: "Contact opt-out recorded" });
                return result({ blocked: input.targetAccountId, evidenceId: evidence.eventId });
            }
            const action = input;
            const writes = ["publish", "reply", "direct", "edit"].includes(action.action);
            let effectiveVisibility = input.visibility;
            let target = typeof input.targetAccountId === "string" ? input.targetAccountId : undefined;
            if (action.action === "reply" || action.action === "edit") {
                const parent = await social.execute({ action: "read_status", targetId: action.targetId });
                if (parent.action !== "read_status")
                    throw new Error("Could not inspect the target status");
                if (action.action === "reply")
                    target = parent.status.account.id;
                else
                    effectiveVisibility = parent.status.visibility;
                if (!parent.status.visibility)
                    throw new Error("Target visibility is unknown; refusing a write");
            }
            const direct = action.action === "direct" || effectiveVisibility === "direct";
            if (writes && direct && !config.allowDirectConversations)
                throw new Error("Direct conversations are disabled");
            if (writes && !direct && !config.allowPublicParticipation)
                throw new Error("Public participation is disabled");
            if (target && await store.isContactBlocked(target))
                throw new Error("Contact opted out");
            if (writes && (typeof input.text !== "string" || !input.text.trim()))
                throw new Error("text is required");
            let operationId;
            let recovered;
            if (writes) {
                operationId = String(input.operationId ?? "");
                if (!/^[a-zA-Z0-9_-]{8,128}$/.test(operationId))
                    throw new Error("Supply a stable operationId (8–128 letters, digits, dashes or underscores)");
                const fingerprint = hash(JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))));
                const reserved = await store.reserveExternal(operationId, fingerprint, { maxPerDay: config.maxSocialActionsPerDay, maxDirect: config.maxDirectConversationsPerDay, direct, target });
                if (!reserved.reserved) {
                    if (reserved.cached && typeof reserved.cached === "object" && "evidenceId" in reserved.cached)
                        return result({ cached: true, result: reserved.cached });
                    recovered = reserved.cached;
                }
            }
            const observed = await observe(callId, "curiosity_social", String(input.targetId ?? target ?? config.mastodon.baseUrl), async () => {
                const output = recovered ?? await social.execute(action);
                if (operationId && !recovered)
                    await store.markExternalSent(operationId, output);
                if ("status" in output && writes) {
                    const location = output.status.url ?? `${config.mastodon.baseUrl}/@${output.status.account.acct}/${output.status.id}`;
                    return { ...output, path: location };
                }
                return output;
            }, writes, writes && !direct && effectiveVisibility !== "private", true);
            const observedData = JSON.parse(observed.content[0].text);
            if (writes && observedData.status) {
                const output = { status: observedData.status };
                const location = String(observedData.path);
                if (target && (action.action === "direct" || action.action === "reply")) {
                    const relationshipId = `relationship-${hash(`${config.mastodon.baseUrl}/${target}`)}`;
                    const previous = await store.get(relationshipId);
                    const history = Array.isArray(previous?.history) ? previous.history.slice(-19) : [];
                    await store.put("relationship", relationshipId, { relationshipId, subject: target, context: "Mastodon conversation", history: [...history, location], lastContactAt: Date.now() });
                }
                // Store the consequence to revisit; no automatic reply is sent.
                await store.put("follow_up", `social-${output.status.id}`, { followUpId: `social-${output.status.id}`, note: "Read responses to this conversation or publication", target: output.status.id, dueAt: Date.now() + 86_400_000, state: "pending" }, "pending");
            }
            if (operationId)
                await store.finishExternal(operationId, JSON.parse(observed.content[0].text));
            return observed;
        });
    }
    return tools;
}
