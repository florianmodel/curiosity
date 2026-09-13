import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import { createTools } from "./plugin-tools.js";
import { DevelopmentStore } from "./store.js";
import type { MastodonAction, MastodonResult, MastodonStatus } from "./tools/social.js";
import type { V2Config } from "./types.js";

const workspaces: string[] = [];
const stores: DevelopmentStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(workspaces.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function sampleStatus(id: string, visibility: MastodonStatus["visibility"] = "public", accountId = "acct-1"): MastodonStatus {
  return {
    id,
    url: `https://example.social/@agent/${id}`,
    createdAt: "2026-09-11T10:00:00Z",
    visibility,
    text: "A small observation",
    account: { id: accountId, acct: "agent@example.social", username: "agent", displayName: "Dedicated Agent" },
  };
}

function socialMock() {
  const execute = vi.fn(async (action: MastodonAction): Promise<MastodonResult> => {
    if (action.action === "read_status") return { action: "read_status", status: sampleStatus(action.targetId, "public", "acct-2") };
    if (action.action === "publish" || action.action === "reply" || action.action === "direct" || action.action === "edit") return { action: action.action, status: sampleStatus(`${action.action}-result`, action.action === "direct" ? "direct" : "public") };
    throw new Error(`unexpected action ${action.action}`);
  });
  return { execute };
}

async function harness(overrides: Partial<V2Config> = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "curiosity-v2-plugin-tools-"));
  workspaces.push(workspace);
  const store = new DevelopmentStore(workspace);
  stores.push(store);
  const social = socialMock();
  const config: V2Config = { ...DEFAULT_CONFIG, mastodon: { baseUrl: "https://example.social", accessTokenEnv: "MASTODON_TOKEN" }, ...overrides };
  const tools = createTools({ store, config, workspace, runId: () => "run-1", social });
  const tool = tools.find(item => item.name === "curiosity_social");
  if (!tool) throw new Error("curiosity_social was not registered");
  return { store, social, tool };
}

async function invoke(tool: { execute: (callId: string, input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }, input: Record<string, unknown>) {
  const result = await tool.execute("social-call", input);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("createTools curiosity_social wrapper", () => {
  it("records authoritative action evidence, publication artifacts, and a consequence follow-up", async () => {
    const { store, tool, social } = await harness();
    const output = await invoke(tool, { action: "publish", text: "A small observation", visibility: "public", operationId: "publish-001" });
    const evidenceId = String(output.evidenceId);
    const event = await store.event(evidenceId);
    expect(event).toMatchObject({ runId: "run-1", kind: "action", toolName: "curiosity_social", success: true });
    expect(social.execute).toHaveBeenCalledTimes(1);
    const snapshot = await store.snapshot();
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]).toMatchObject({ kind: "publication", public: true, location: "https://example.social/@agent/publish-result" });
    expect(snapshot.followUps).toEqual(expect.arrayContaining([expect.objectContaining({ target: "publish-result", state: "pending" })]));
  });

  it("deduplicates a completed operation without sending again or losing evidence metadata", async () => {
    const { tool, social } = await harness();
    const first = await invoke(tool, { action: "publish", text: "Same post", visibility: "public", operationId: "publish-002" });
    const second = await invoke(tool, { action: "publish", text: "Same post", visibility: "public", operationId: "publish-002" });
    expect(social.execute).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect((second.result as Record<string, unknown>).evidenceId).toBe(first.evidenceId);
  });

  it("keeps failed or uncertain sends pending so the same operation cannot be retried", async () => {
    const { tool, social } = await harness();
    social.execute.mockRejectedValueOnce(new Error("network timeout"));
    await expect(invoke(tool, { action: "publish", text: "Uncertain", visibility: "public", operationId: "publish-003" })).rejects.toThrow("network timeout");
    await expect(invoke(tool, { action: "publish", text: "Uncertain", visibility: "public", operationId: "publish-003" })).rejects.toThrow(/pending|uncertain/);
    expect(social.execute).toHaveBeenCalledTimes(1);
  });

  it("recovers a sent operation after consequence persistence fails without republishing", async () => {
    const { store, tool, social } = await harness();
    const put = vi.spyOn(store, "put");
    let failFollowUp = true;
    put.mockImplementation(async (kind, id, body, state, createdAt) => {
      if (kind === "follow_up" && failFollowUp) {
        failFollowUp = false;
        throw new Error("follow-up persistence failed");
      }
      return DevelopmentStore.prototype.put.call(store, kind, id, body, state, createdAt);
    });

    const input = { action: "publish", text: "Recover this publication", visibility: "public", operationId: "publish-recover-001" };
    await expect(invoke(tool, input)).rejects.toThrow("follow-up persistence failed");
    expect(social.execute).toHaveBeenCalledTimes(1);

    const replay = await invoke(tool, input);
    expect(replay.action).toBe("publish");
    expect(replay.evidenceId).toEqual(expect.any(String));
    expect(social.execute).toHaveBeenCalledTimes(1);

    const completed = await invoke(tool, input);
    expect(completed.cached).toBe(true);
    expect((completed.result as Record<string, unknown>).evidenceId).toBe(replay.evidenceId);
    const snapshot = await store.snapshot();
    expect(snapshot.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ location: "https://example.social/@agent/publish-result" })]));
    expect(snapshot.followUps).toEqual(expect.arrayContaining([expect.objectContaining({ target: "publish-result", state: "pending" })]));
  });

  it("enforces daily quotas independently for public actions and direct conversations", async () => {
    const { tool, social } = await harness({ maxSocialActionsPerDay: 1, maxDirectConversationsPerDay: 1 });
    await invoke(tool, { action: "publish", text: "First", visibility: "public", operationId: "publish-004" });
    await expect(invoke(tool, { action: "publish", text: "Second", visibility: "public", operationId: "publish-005" })).rejects.toThrow(/Daily social action limit/);
    expect(social.execute).toHaveBeenCalledTimes(1);

    const directHarness = await harness({ maxSocialActionsPerDay: 2, maxDirectConversationsPerDay: 0 });
    await expect(invoke(directHarness.tool, { action: "direct", targetAccountId: "acct-2", text: "Hello", visibility: "direct", operationId: "direct-001" })).rejects.toThrow(/Daily social action limit/);
  });

  it("blocks opted-out recipients for both reply and direct initiation", async () => {
    const reply = await harness();
    await reply.store.blockContact("acct-2", "asked not to be contacted");
    await expect(invoke(reply.tool, { action: "reply", targetId: "parent-1", text: "A response", visibility: "public", operationId: "reply-001" })).rejects.toThrow(/opted out/);
    expect(reply.social.execute).toHaveBeenCalledTimes(1); // parent lookup only

    const direct = await harness();
    await direct.store.blockContact("acct-2", "asked not to be contacted");
    await expect(invoke(direct.tool, { action: "direct", targetAccountId: "acct-2", text: "A message", visibility: "direct", operationId: "direct-002" })).rejects.toThrow(/opted out/);
    expect(direct.social.execute).not.toHaveBeenCalled();
  });

  it("keeps public participation and direct conversations as separate gates", async () => {
    const publicOff = await harness({ allowPublicParticipation: false, allowDirectConversations: true });
    await expect(invoke(publicOff.tool, { action: "publish", text: "Public", visibility: "public", operationId: "publish-006" })).rejects.toThrow(/Public participation is disabled/);
    await expect(invoke(publicOff.tool, { action: "direct", targetAccountId: "acct-2", text: "Direct", visibility: "direct", operationId: "direct-003" })).resolves.toMatchObject({ action: "direct" });

    const directOff = await harness({ allowPublicParticipation: true, allowDirectConversations: false });
    await expect(invoke(directOff.tool, { action: "direct", targetAccountId: "acct-2", text: "Direct", visibility: "direct", operationId: "direct-004" })).rejects.toThrow(/Direct conversations are disabled/);
  });

  it("does not expose the configured token environment name or token in the tool surface", async () => {
    const { tool } = await harness();
    expect(JSON.stringify(tool.parameters)).not.toContain("MASTODON_TOKEN");
    expect(tool.description).not.toContain("MASTODON_TOKEN");
    expect(JSON.stringify(tool.parameters)).not.toContain("secret-token");
  });

  it("records an auditable evidence event when blocking a contact", async () => {
    const { store, tool } = await harness();
    const output = await invoke(tool, { action: "block_contact", targetAccountId: "acct-9", reason: "asked not to be contacted" });
    expect(output.blocked).toBe("acct-9");
    expect(output.evidenceId).toEqual(expect.any(String));
    await expect(store.event(String(output.evidenceId))).resolves.toMatchObject({ kind: "action", toolName: "curiosity_social", target: "acct-9" });
    await expect(store.listEvents()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "contact_blocked", target: "acct-9" })]));
  });

  it("checks the edited post visibility before allowing an edit when direct participation is disabled", async () => {
    const { tool, social } = await harness({ allowPublicParticipation: true, allowDirectConversations: false });
    social.execute.mockImplementation(async action => {
      if (action.action === "read_status") return { action: "read_status", status: sampleStatus(action.targetId, "direct", "acct-1") };
      return { action: "edit", status: sampleStatus("edited", "direct", "acct-1") };
    });
    await expect(invoke(tool, { action: "edit", targetId: "own-direct", text: "Edited", operationId: "edit-001" })).rejects.toThrow(/Direct conversations are disabled/);
    expect(social.execute).toHaveBeenCalledWith({ action: "read_status", targetId: "own-direct" });
  });
});
