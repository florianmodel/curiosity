const schema = {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
        action: { type: "string", enum: ["snapshot", "put_self", "put_interest", "put_project", "put_relationship", "put_artifact", "record_experience", "record_resource_request", "record_self_modification", "record_turn", "record_visit"] },
        record: { type: "object", description: "Complete record body for the chosen action." }
    }
};
const ids = {
    put_self: "revisionId", put_interest: "interestId", put_project: "projectId",
    put_relationship: "relationshipId", put_artifact: "artifactId",
    record_experience: "experienceId", record_resource_request: "requestId", record_self_modification: "modificationId",
    record_turn: "turnId", record_visit: "visitId",
};
const kinds = {
    put_self: "self", put_interest: "interest", put_project: "project",
    put_relationship: "relationship", put_artifact: "artifact",
    record_experience: "experience", record_resource_request: "resource_request", record_self_modification: "self_modification",
    record_turn: "turn", record_visit: "visit",
};
const modes = new Set(["wander", "follow", "make", "participate", "reflect", "self_modify"]);
function validateTurn(record) {
    if (!modes.has(String(record.mode)))
        return "mode must be one of wander, follow, make, participate, reflect, self_modify";
    const action = record.action;
    const hasAction = !!action && typeof action === "object" && typeof action.kind === "string" && typeof action.outcome === "string" && action.outcome.length > 0;
    const hasBlock = typeof record.blockedReason === "string" && record.blockedReason.length > 0;
    if (!hasAction && !hasBlock)
        return "record.action (with kind and outcome) or record.blockedReason is required";
    if (hasAction && hasBlock)
        return "a turn reports either an action or a blockedReason, not both";
    return undefined;
}
export function createDevelopmentTool(store) {
    return {
        name: "curiosity_v2",
        description: "Recall or persist genuine developmental state: self, interests, projects, experiences, turn reports, visits, resource requests, and reversible self-modifications. Every developmental turn must end with a record_turn. This tool never spends money.",
        parameters: schema,
        execute: async (_id, input) => {
            const action = String(input.action ?? "snapshot");
            if (action === "snapshot")
                return { content: [{ type: "text", text: JSON.stringify(await store.snapshot(), null, 2) }] };
            const record = input.record && typeof input.record === "object" ? { ...input.record } : null;
            if (!record || !ids[action] || !kinds[action])
                throw new Error(`Invalid curiosity_v2 action: ${action}`);
            if (action === "record_turn") {
                const problem = validateTurn(record);
                if (problem)
                    throw new Error(`Invalid turn report: ${problem}`);
            }
            if (action === "record_visit" && !(typeof record.location === "string" && record.location.length > 0)) {
                throw new Error("Invalid visit: record.location is required");
            }
            const idKey = ids[action];
            const id = typeof record[idKey] === "string" && record[idKey] ? String(record[idKey]) : store.id(kinds[action]);
            record[idKey] = id;
            if (typeof record.createdAt !== "number")
                record.createdAt = Date.now();
            if (action === "record_resource_request")
                record.status = "recorded";
            if (action === "record_visit" && typeof record.kind !== "string")
                record.kind = "other";
            if (action === "record_turn" && typeof record.runId !== "string")
                delete record.runId;
            if (action === "record_self_modification") {
                const forbidden = /(?:audit trail|identity truth|stage 0|spending prohibition|credential isolation|emergency stop|safety control)/i;
                if (forbidden.test(`${record.motivation ?? ""} ${record.summary ?? ""}`))
                    throw new Error("Immutable-kernel self-modification rejected");
            }
            await store.put(kinds[action], id, record, typeof record.state === "string" ? record.state : typeof record.status === "string" ? record.status : undefined, Number(record.createdAt));
            return { content: [{ type: "text", text: `Recorded ${kinds[action]} ${id}.` }] };
        },
    };
}
