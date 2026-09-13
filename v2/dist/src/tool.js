const actions = [
    "snapshot", "get", "get_record", "search", "search_records", "history", "record_history", "timeline", "list_events",
    "put_self", "put_interest", "put_project", "put_relationship", "put_artifact", "record_experience",
    "record_resource_request", "record_self_modification", "record_turn", "record_visit", "put_follow_up", "put_followup", "resolve_follow_up", "resolve_followup",
];
const schema = {
    type: "object", additionalProperties: false, required: ["action"],
    properties: {
        action: { type: "string", enum: actions }, id: { type: "string" }, kind: { type: "string" }, query: { type: "string" },
        limit: { type: "number" }, after: { type: "number" }, runId: { type: "string" },
        record: {
            type: "object", description: "Complete record body for a new record, or a partial patch for an existing record. For put_interest use name, state, attraction, origin, currentUnderstanding, openQuestions, predictions, surprises, connections, and returnCount. For put_project use name, state, intention, nextMove, artifactIds, and optional interestId. For put_follow_up use note, dueAt (epoch milliseconds), and optional interestId/projectId. Arrays contain strings.",
            properties: {
                revisionId: { type: "string" }, interestId: { type: "string" }, projectId: { type: "string" }, relationshipId: { type: "string" }, artifactId: { type: "string" },
                experienceId: { type: "string" }, requestId: { type: "string" }, modificationId: { type: "string" }, turnId: { type: "string" }, visitId: { type: "string" }, followUpId: { type: "string" },
                createdAt: { type: "number" }, updatedAt: { type: "number" }, dueAt: { type: "number", description: "Epoch milliseconds." }, nextReturnAt: { type: "number", description: "Epoch milliseconds." },
                state: { type: "string", enum: ["forming", "active", "dormant", "abandoned", "imagined", "paused", "completed", "pending", "snoozed"] }, status: { type: "string" },
                name: { type: "string" }, note: { type: "string" }, narrative: { type: "string" }, attraction: { type: "string" }, origin: { type: "string" }, currentUnderstanding: { type: "string" },
                intention: { type: "string" }, nextMove: { type: "string" }, subject: { type: "string" }, context: { type: "string" }, summary: { type: "string" },
                resource: { type: "string" }, reason: { type: "string" }, location: { type: "string" }, description: { type: "string" }, public: { type: "boolean" },
                mode: { type: "string", enum: ["wander", "follow", "make", "participate", "reflect", "self_modify"] }, runId: { type: "string", description: "Assigned by the current runtime; supplied values are ignored." },
                returnCount: { type: "number" }, lastEngagedAt: { type: "number" }, completedAt: { type: "number" }, quietReason: { type: "string" }, blockedReason: { type: "string" },
                files: { type: "array", items: { type: "string" } }, testEvidence: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "string" }, description: "Event IDs from successful action events in the current run." },
                traits: { type: "array", items: { type: "string" } }, tastes: { type: "array", items: { type: "string" } }, tensions: { type: "array", items: { type: "string" } }, openQuestions: { type: "array", items: { type: "string" } }, predictions: { type: "array", items: { type: "string" } }, surprises: { type: "array", items: { type: "string" } }, connections: { type: "array", items: { type: "string" } }, artifactIds: { type: "array", items: { type: "string" } },
                action: { type: "object", properties: { kind: { type: "string" }, target: { type: "string" }, outcome: { type: "string" }, evidence: { type: "array", items: { type: "string" }, description: "Successful action event IDs from this run." } } },
                nextHook: { type: "object", properties: { note: { type: "string" }, dueAt: { type: "number", description: "Epoch milliseconds." }, interestId: { type: "string" }, projectId: { type: "string" } } },
            },
        },
    },
};
const ids = {
    put_self: "revisionId", put_interest: "interestId", put_project: "projectId", put_relationship: "relationshipId", put_artifact: "artifactId",
    record_experience: "experienceId", record_resource_request: "requestId", record_self_modification: "modificationId", record_turn: "turnId", record_visit: "visitId",
    put_follow_up: "followUpId", put_followup: "followUpId",
};
const kinds = {
    put_self: "self", put_interest: "interest", put_project: "project", put_relationship: "relationship", put_artifact: "artifact",
    record_experience: "experience", record_resource_request: "resource_request", record_self_modification: "self_modification", record_turn: "turn", record_visit: "visit",
    put_follow_up: "follow_up", put_followup: "follow_up",
};
const modes = new Set(["wander", "follow", "make", "participate", "reflect", "self_modify"]);
const interestStates = new Set(["forming", "active", "dormant", "abandoned"]);
const projectStates = new Set(["imagined", "active", "paused", "completed", "abandoned"]);
const followupStates = new Set(["pending", "snoozed", "completed", "abandoned"]);
function string(value, name, required = false) {
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`${name} is required`);
        return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`${name} must be a nonempty string`);
    return value;
}
function number(value, name, required = false) {
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`${name} is required`);
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${name} must be a finite number`);
    return value;
}
function strings(value, name, required = false) {
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`${name} is required`);
        return undefined;
    }
    if (!Array.isArray(value) || value.some(item => typeof item !== "string"))
        throw new Error(`${name} must be an array of strings`);
    return value;
}
function nonEmptyStrings(value, name) {
    const values = strings(value, name, true) ?? [];
    if (values.length === 0)
        throw new Error(`${name} must contain at least one value`);
    return values;
}
function state(value, allowed, name) {
    if (value !== undefined && (typeof value !== "string" || !allowed.has(value)))
        throw new Error(`${name} has an invalid value`);
}
function validateCommon(record) {
    for (const key of ["createdAt", "updatedAt", "dueAt", "nextReturnAt", "lastEngagedAt", "returnCount", "completedAt"])
        if (record[key] !== undefined && record[key] !== null)
            number(record[key], key);
    for (const key of ["traits", "tastes", "tensions", "evidence", "openQuestions", "predictions", "surprises", "connections", "artifactIds", "history", "commitments", "boundaries", "freeAlternatives", "files", "testEvidence"])
        if (record[key] !== undefined)
            strings(record[key], key);
}
function validateRecord(action, record, merged, isNew) {
    validateCommon(record);
    if (action === "put_self") {
        string(merged.narrative, "narrative", isNew);
        for (const key of ["traits", "tastes", "tensions", "evidence"])
            strings(merged[key], key);
    }
    else if (action === "put_interest") {
        string(merged.name, "name", isNew);
        state(merged.state, interestStates, "interest state");
        for (const key of ["openQuestions", "predictions", "surprises", "connections"])
            strings(merged[key], key);
    }
    else if (action === "put_project") {
        string(merged.name, "name", isNew);
        state(merged.state, projectStates, "project state");
        string(merged.intention, "intention");
        string(merged.nextMove, "nextMove");
        strings(merged.artifactIds, "artifactIds");
    }
    else if (action === "put_relationship") {
        string(merged.subject, "subject", isNew);
        string(merged.context, "context");
    }
    else if (action === "put_artifact") {
        string(merged.name, "name", isNew);
        string(merged.kind, "kind");
        string(merged.location, "location", isNew);
        string(merged.description, "description");
    }
    else if (action === "record_experience") {
        string(merged.summary, "summary", isNew);
        string(merged.runId, "runId", isNew);
        state(merged.mode, modes, "mode");
        strings(merged.evidence, "evidence");
    }
    else if (action === "record_resource_request") {
        string(merged.resource, "resource", isNew);
        string(merged.reason, "reason", isNew);
        if (merged.status !== undefined && !["recorded", "dismissed", "approved_later"].includes(String(merged.status)))
            throw new Error("resource request status is invalid");
    }
    else if (action === "record_visit") {
        string(merged.location, "location", true);
        string(merged.note, "note");
        if (merged.kind !== undefined && !["web", "file", "other"].includes(String(merged.kind)))
            throw new Error("visit kind must be web, file, or other");
    }
    else if (action === "record_self_modification" && merged.status !== undefined && !["proposed", "tested", "adopted", "reverted", "rejected"].includes(String(merged.status)))
        throw new Error("self-modification status is invalid");
    else if (action === "put_follow_up" || action === "put_followup") {
        string(merged.note, "note", isNew);
        number(merged.dueAt, "dueAt", isNew);
        state(merged.state, followupStates, "follow-up state");
    }
}
function validateTurn(record) {
    if (typeof record.mode !== "string" || !modes.has(record.mode))
        throw new Error("mode must be one of wander, follow, make, participate, reflect, self_modify");
    const action = record.action;
    const hasAction = !!action && typeof action === "object" && typeof action.kind === "string" && action.kind.trim().length > 0 && typeof action.outcome === "string" && action.outcome.trim().length > 0;
    const hasBlock = typeof record.blockedReason === "string" && record.blockedReason.trim().length > 0;
    const hasQuiet = typeof record.quietReason === "string" && record.quietReason.trim().length > 0;
    if (!hasAction && !hasBlock && !hasQuiet)
        throw new Error("record.action, record.blockedReason, or record.quietReason is required");
    if ([hasAction, hasBlock, hasQuiet].filter(Boolean).length > 1)
        throw new Error("a turn reports one of action, blockedReason, or quietReason");
    if (hasAction && action && action.evidence !== undefined)
        strings(action.evidence, "action.evidence", true);
    if (hasAction && action && action.target !== undefined)
        string(action.target, "action.target");
    if (record.nextHook !== undefined) {
        if (!record.nextHook || typeof record.nextHook !== "object")
            throw new Error("nextHook must be an object");
        string(record.nextHook.note, "nextHook.note", true);
        number(record.nextHook.dueAt, "nextHook.dueAt");
    }
}
async function requireActionEvidence(store, action, runId) {
    if (!runId)
        throw new Error("An acted turn requires a current run context");
    const evidence = strings(action.evidence, "action.evidence", true) ?? [];
    if (!evidence.length)
        throw new Error("An acted turn requires evidence event IDs");
    const events = await Promise.all(evidence.map(id => store.event(id)));
    if (events.some(event => !event || event.runId !== runId || event.success !== true || event.kind !== "action"))
        throw new Error("Action evidence must be successful action events from the current run");
}
async function requireEvidence(store, refs, runId) {
    if (!runId)
        throw new Error("Evidence requires a current run context");
    const ids = strings(refs, "evidence", true) ?? [];
    if (!ids.length)
        throw new Error("Evidence event IDs are required");
    const events = await Promise.all(ids.map(id => store.event(id)));
    if (events.some(event => !event || event.runId !== runId || event.success !== true || event.kind !== "action"))
        throw new Error("Evidence must reference successful action events from the current run");
    return ids;
}
function result(value) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2) }] }; }
async function resolveFollowUp(store, record, runId) {
    const id = typeof record.followUpId === "string" ? record.followUpId : typeof record.id === "string" ? record.id : "";
    if (!id)
        throw new Error("followUpId is required");
    const existing = await store.get(id);
    if (!existing || existing.followUpId === undefined)
        throw new Error("Follow-up was not found");
    const nextState = record.state;
    if (typeof nextState !== "string" || !followupStates.has(nextState))
        throw new Error("follow-up state must be pending, snoozed, completed, or abandoned");
    for (const key of ["interestId", "projectId"]) {
        if (record[key] !== undefined && record[key] !== existing[key])
            throw new Error(`Follow-up ${key} cannot be rebound during resolution`);
    }
    if (nextState === "snoozed") {
        const dueAt = number(record.dueAt, "dueAt", true);
        if (dueAt <= Date.now())
            throw new Error("snoozed follow-up dueAt must be in the future");
    }
    if (nextState === "completed" && existing.state === "completed")
        return id;
    if (nextState === "completed")
        await requireEvidence(store, record.evidence, runId);
    const now = Date.now();
    const merged = { ...existing, ...record, followUpId: id, state: nextState, updatedAt: now, ...(nextState === "completed" ? { completedAt: now } : {}) };
    await store.put("follow_up", id, merged, nextState, Number(existing.createdAt ?? now));
    if (nextState === "completed") {
        const interestId = typeof merged.interestId === "string" ? merged.interestId : undefined;
        const projectId = typeof merged.projectId === "string" ? merged.projectId : undefined;
        const refId = interestId ?? projectId;
        if (refId) {
            const reference = await store.get(refId);
            if (reference) {
                const count = typeof reference.returnCount === "number" ? reference.returnCount : 0;
                const patch = { returnCount: count + 1, lastEngagedAt: now, nextReturnAt: merged.nextReturnAt ?? null };
                await store.put(interestId ? "interest" : "project", refId, patch, typeof reference.state === "string" ? reference.state : undefined, Number(reference.createdAt ?? now));
            }
        }
    }
    return id;
}
export function createDevelopmentTool(store, context = {}) {
    const currentRunId = context.runId;
    return {
        name: "curiosity_v2",
        description: "Recall or persist developmental state, search older records, inspect evidence, and report acted, quiet, or blocked turns. Acted claims must cite successful action evidence from the current run. This tool never spends money.",
        parameters: schema,
        execute: async (_id, input) => {
            const action = String(input.action ?? "snapshot");
            if (action === "snapshot")
                return result(await store.snapshot());
            if (action === "get" || action === "get_record")
                return result(await store.get(String(input.id ?? input.recordId ?? "")));
            if (action === "search" || action === "search_records")
                return result(await store.search(String(input.query ?? ""), typeof input.kind === "string" ? input.kind : undefined, Number(input.limit ?? 30)));
            if (action === "history" || action === "record_history")
                return result(await store.history(String(input.id ?? input.recordId ?? ""), Number(input.limit ?? 30)));
            if (action === "timeline" || action === "list_events")
                return result(await store.listEvents({ runId: typeof input.runId === "string" ? input.runId : undefined, after: typeof input.after === "number" ? input.after : undefined, limit: Number(input.limit ?? 50) }));
            if (action === "resolve_follow_up" || action === "resolve_followup") {
                const rawResolution = input.record && typeof input.record === "object" ? { ...input.record } : {};
                if (rawResolution.followUpId === undefined && typeof input.id === "string")
                    rawResolution.followUpId = input.id;
                return result(`Resolved follow_up ${await resolveFollowUp(store, rawResolution, currentRunId)}.`);
            }
            const raw = input.record && typeof input.record === "object" ? { ...input.record } : null;
            if (!raw || !ids[action] || !kinds[action])
                throw new Error(`Invalid curiosity_v2 action: ${action}`);
            const idKey = ids[action];
            const id = typeof raw[idKey] === "string" && raw[idKey] ? String(raw[idKey]) : store.id(kinds[action]);
            const existing = await store.get(id);
            const merged = { ...(existing ?? {}), ...raw };
            const isNew = !existing;
            if (action === "record_turn") {
                validateTurn(raw);
                const turnAction = raw.action;
                if (turnAction && typeof turnAction === "object")
                    await requireActionEvidence(store, turnAction, currentRunId);
                raw.runId = currentRunId;
                if (!turnAction)
                    raw.action = null;
                if (typeof raw.blockedReason !== "string")
                    raw.blockedReason = null;
                if (typeof raw.quietReason !== "string")
                    raw.quietReason = null;
            }
            else {
                if (action === "record_experience")
                    raw.runId = currentRunId;
                validateRecord(action, raw, { ...merged, ...(action === "record_experience" ? { runId: currentRunId } : {}) }, isNew);
            }
            if (action === "record_visit" && typeof raw.kind !== "string")
                raw.kind = "other";
            if (action === "record_resource_request" && raw.status === undefined)
                raw.status = "recorded";
            if (action === "record_self_modification") {
                const forbidden = /(?:audit trail|identity truth|stage 0|spending prohibition|credential isolation|emergency stop|safety control)/i;
                if (forbidden.test(`${raw.motivation ?? ""} ${raw.summary ?? ""}`))
                    throw new Error("Immutable-kernel self-modification rejected");
                const requested = String(merged.status ?? "proposed");
                raw.status = requested;
                if (["tested", "adopted"].includes(requested)) {
                    nonEmptyStrings(merged.files, "files");
                    string(merged.rollback, "rollback", true);
                    nonEmptyStrings(merged.testEvidence, "testEvidence");
                    const evidenceIds = await requireEvidence(store, merged.evidence, currentRunId);
                    const evidenceEvents = await Promise.all(evidenceIds.map(eventId => store.event(eventId)));
                    if (evidenceEvents.every(event => !event || !/(?:exec|test)/i.test(event.toolName ?? "")))
                        throw new Error("Self-modification requires successful exec/test evidence");
                }
            }
            if (action === "record_turn" && typeof raw.nextHook === "object" && raw.nextHook !== null) {
                const hook = raw.nextHook;
                string(hook.note, "nextHook.note", true);
                const followUpId = typeof hook.followUpId === "string" ? hook.followUpId : store.id("follow_up");
                const followUp = { ...hook, followUpId, createdAt: Date.now(), updatedAt: Date.now(), state: "pending", dueAt: typeof hook.dueAt === "number" ? hook.dueAt : Date.now() + 86_400_000 };
                await store.put("follow_up", followUpId, followUp, "pending", followUp.createdAt);
            }
            if (action === "put_follow_up" || action === "put_followup") {
                if (raw.state === undefined && isNew)
                    raw.state = "pending";
                if (raw.state === "snoozed") {
                    const dueAt = number(raw.dueAt ?? merged.dueAt, "dueAt", true);
                    if (dueAt <= Date.now())
                        throw new Error("snoozed follow-up dueAt must be in the future");
                }
                if (raw.state === "completed") {
                    await requireEvidence(store, raw.evidence, currentRunId);
                    if (isNew)
                        throw new Error("A new follow-up must be pending before it can be completed");
                    return result(`Resolved follow_up ${await resolveFollowUp(store, { ...raw, followUpId: id }, currentRunId)}.`);
                }
            }
            if (typeof raw.createdAt !== "number")
                raw.createdAt = isNew ? Date.now() : undefined;
            raw[idKey] = id;
            await store.put(kinds[action], id, raw, typeof raw.state === "string" ? raw.state : typeof raw.status === "string" ? raw.status : undefined, typeof raw.createdAt === "number" ? raw.createdAt : Date.now());
            return result(`Recorded ${kinds[action]} ${id}.`);
        },
    };
}
