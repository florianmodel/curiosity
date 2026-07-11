import type { DevelopmentStore } from "./store.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["snapshot", "put_self", "put_interest", "put_project", "put_relationship", "put_artifact", "record_experience", "record_resource_request", "record_self_modification"] },
    record: { type: "object", description: "Complete record body for the chosen action." }
  }
} as const;

const ids: Record<string, string> = {
  put_self: "revisionId", put_interest: "interestId", put_project: "projectId",
  put_relationship: "relationshipId", put_artifact: "artifactId",
  record_experience: "experienceId", record_resource_request: "requestId", record_self_modification: "modificationId",
};
const kinds: Record<string, string> = {
  put_self: "self", put_interest: "interest", put_project: "project",
  put_relationship: "relationship", put_artifact: "artifact",
  record_experience: "experience", record_resource_request: "resource_request", record_self_modification: "self_modification",
};

export function createDevelopmentTool(store: DevelopmentStore) {
  return {
    name: "curiosity_v2",
    description: "Recall or persist genuine developmental state: self, interests, projects, experiences, resource requests, and reversible self-modifications. This tool never spends money.",
    parameters: schema,
    execute: async (_id: string, input: Record<string, unknown>) => {
      const action = String(input.action ?? "snapshot");
      if (action === "snapshot") return { content: [{ type: "text", text: JSON.stringify(await store.snapshot(), null, 2) }] };
      const record = input.record && typeof input.record === "object" ? { ...(input.record as Record<string, unknown>) } : null;
      if (!record || !ids[action] || !kinds[action]) throw new Error(`Invalid curiosity_v2 action: ${action}`);
      const idKey = ids[action];
      const id = typeof record[idKey] === "string" && record[idKey] ? String(record[idKey]) : store.id(kinds[action]);
      record[idKey] = id;
      if (typeof record.createdAt !== "number") record.createdAt = Date.now();
      if (action === "record_resource_request") record.status = "recorded";
      if (action === "record_self_modification") {
        const forbidden = /(?:audit trail|identity truth|stage 0|spending prohibition|credential isolation|emergency stop|safety control)/i;
        if (forbidden.test(`${record.motivation ?? ""} ${record.summary ?? ""}`)) throw new Error("Immutable-kernel self-modification rejected");
      }
      await store.put(kinds[action], id, record, typeof record.state === "string" ? record.state : typeof record.status === "string" ? record.status : undefined, Number(record.createdAt));
      return { content: [{ type: "text", text: `Recorded ${kinds[action]} ${id}.` }] };
    },
  };
}
