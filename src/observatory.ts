import type { IncomingMessage, ServerResponse } from "node:http";
import { executeCuriosityRun } from "./executor.js";
import type { CuriosityManager } from "./manager.js";

type ResolveManager = (workspaceDir: string) => Promise<CuriosityManager>;

type ObservatoryRouteParams = {
  workspaceDir: string;
  agentId: string;
  gatewayUrl: string;
  runtimeConfig: unknown;
  resolveManager: ResolveManager;
  logger: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
};

function sendJson(res: ServerResponse, statusCode: number, value: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value, null, 2));
}

function sendText(res: ServerResponse, statusCode: number, value: string, contentType = "text/plain; charset=utf-8") {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", contentType);
  res.end(value);
}

function observatoryHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Curiosity Observatory</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --text: #161616;
      --muted: #686868;
      --line: #d9d9d2;
      --accent: #0f766e;
      --accent-2: #8a4b12;
      --bad: #b42318;
      --good: #166534;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #141414;
        --panel: #1d1d1b;
        --text: #eeeeea;
        --muted: #aaa69f;
        --line: #34342f;
        --accent: #5eead4;
        --accent-2: #f0b35d;
        --bad: #f87171;
        --good: #86efac;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { font-size: 18px; margin: 0; letter-spacing: 0; }
    h2 { font-size: 14px; margin: 0 0 10px; letter-spacing: 0; }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      min-height: 32px;
      padding: 6px 10px;
      cursor: pointer;
    }
    button.primary { border-color: var(--accent); color: var(--accent); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    main {
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      gap: 18px;
      padding: 18px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
    .stack { display: grid; gap: 18px; align-content: start; }
    .controls { display: flex; gap: 8px; flex-wrap: wrap; }
    .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .stat { border-top: 1px solid var(--line); padding-top: 8px; min-width: 0; }
    .label { color: var(--muted); font-size: 12px; }
    .value { font-size: 16px; margin-top: 2px; overflow-wrap: anywhere; }
    .list { display: grid; gap: 8px; max-height: 460px; overflow: auto; padding-right: 2px; }
    .row {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px;
      background: color-mix(in srgb, var(--panel) 92%, var(--bg));
    }
    .row.clickable { cursor: pointer; }
    .row.clickable:hover { border-color: var(--accent); }
    .row-title { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
    .row-meta { color: var(--muted); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
    .timeline { display: grid; gap: 8px; }
    .pill {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      color: var(--muted);
      margin-right: 5px;
    }
    .good { color: var(--good); }
    .bad { color: var(--bad); }
    .accent { color: var(--accent); }
    pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      color: var(--text);
    }
    a { color: var(--accent); }
    .muted { color: var(--muted); }
    .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
    @media (max-width: 980px) {
      main { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Curiosity Observatory</h1>
      <div id="subtitle" class="label">Loading...</div>
    </div>
    <div class="controls">
      <button id="refresh" class="primary">Refresh</button>
      <button id="wake">Start one run</button>
      <button id="pause">Pause</button>
      <button id="resume">Resume</button>
    </div>
  </header>
  <main>
    <div class="stack">
      <section>
        <h2>State</h2>
        <div id="stats" class="stats"></div>
      </section>
      <section>
        <h2>Recent Runs</h2>
        <div id="runs" class="list"></div>
      </section>
      <section>
        <h2>Goals</h2>
        <div id="goals" class="list"></div>
      </section>
    </div>
    <div class="stack">
      <section>
        <h2>Run Detail</h2>
        <div id="detail" class="muted">Select a run to inspect its full trace.</div>
      </section>
      <section>
        <h2>Recent Events</h2>
        <div id="events" class="timeline"></div>
      </section>
      <section>
        <h2>Recent Observations</h2>
        <div id="observations" class="timeline"></div>
      </section>
    </div>
  </main>
  <script>
    const state = { selectedRunId: new URLSearchParams(location.search).get("run") || "" };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);
    const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : "n/a";
    const fmtDuration = (ms) => typeof ms === "number" ? (ms / 1000).toFixed(1) + "s" : "n/a";
    const fmtBytes = (bytes) => {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = bytes;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return size.toFixed(index === 0 ? 0 : 1) + " " + units[index];
    };
    async function api(path, options = {}) {
      const response = await fetch("/curiosity/api" + path, {
        ...options,
        headers: { "Accept": "application/json", ...(options.headers || {}) }
      });
      if (!response.ok) throw new Error(await response.text());
      return await response.json();
    }
    function stat(label, value) {
      return '<div class="stat"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div></div>';
    }
    function statusClass(value) {
      if (value === true || value === "completed") return "good";
      if (value === false || value === "failed") return "bad";
      return "";
    }
    function renderStats(data) {
      $("subtitle").textContent = data.workspaceDir + " | generated " + fmtTime(data.generatedAt);
      $("stats").innerHTML = [
        stat("Paused", data.paused ? "yes" : "no"),
        stat("Boredom", ((data.boredom?.level ?? 0) * 100).toFixed(1) + "%"),
        stat("Autonomous runs 24h", data.budgetUsage?.autonomousRuns24h ?? 0),
        stat("Tokens 24h", data.budgetUsage?.autonomousTokens24h ?? 0),
        stat("External actions 24h", data.budgetUsage?.externalActions24h ?? 0),
        stat("External actions 1h", data.budgetUsage?.externalActions1h ?? 0),
        stat("Retention days", data.retention?.retentionDays ?? "n/a"),
        stat("Storage cap", fmtBytes(data.retention?.maxStorageBytes ?? 0))
      ].join("");
    }
    function renderRuns(runs) {
      $("runs").innerHTML = runs.map((run) => {
        const cls = statusClass(run.success);
        return '<div class="row clickable" data-run="' + esc(run.runId) + '">' +
          '<div class="row-title">' + esc(run.runId) + '</div>' +
          '<div class="row-meta"><span class="' + cls + '">' + esc(run.success == null ? "pending" : run.success ? "success" : "failed") + '</span> | ' +
          esc(run.trigger) + ' | ' + fmtTime(run.startedAt) + ' | ' + fmtDuration(run.durationMs) + ' | tokens ' + esc(run.totalTokens ?? "n/a") + '</div>' +
        '</div>';
      }).join("") || '<div class="muted">No runs yet.</div>';
      document.querySelectorAll("[data-run]").forEach((node) => {
        node.addEventListener("click", () => selectRun(node.getAttribute("data-run")));
      });
    }
    function renderGoals(goals) {
      $("goals").innerHTML = goals.map((goal) =>
        '<div class="row">' +
          '<div class="row-title">' + esc(goal.title) + '</div>' +
          '<div class="row-meta">' + esc(goal.status) + ' | ' + esc(goal.source) + ' | score ' +
          esc(goal.scoresByModel?.active_ensemble?.toFixed?.(3) ?? "n/a") + ' | run ' + esc(goal.lastRunId ?? "n/a") + '</div>' +
        '</div>'
      ).join("") || '<div class="muted">No goals yet.</div>';
    }
    function renderEvents(events, target = $("events")) {
      target.innerHTML = events.map((event) =>
        '<div class="row">' +
          '<div><span class="pill">' + esc(event.eventType) + '</span><span class="muted">' + fmtTime(event.ts) + '</span></div>' +
          '<div class="row-meta">' + esc(event.runId ?? "") + '</div>' +
          '<pre>' + esc(JSON.stringify(event.payload ?? {}, null, 2)) + '</pre>' +
        '</div>'
      ).join("") || '<div class="muted">No events yet.</div>';
    }
    function rawLink(observation) {
      return observation.metadata?.rawContentPath
        ? ' <a href="/curiosity/api/raw/' + encodeURIComponent(observation.id) + '" target="_blank" rel="noreferrer">raw</a>'
        : "";
    }
    function renderObservations(observations, target = $("observations")) {
      target.innerHTML = observations.map((observation) =>
        '<div class="row">' +
          '<div><span class="pill">' + esc(observation.kind) + '</span><span class="muted">' + fmtTime(observation.createdAt) + rawLink(observation) + '</span></div>' +
          '<div class="row-meta">' + esc([observation.runId, observation.toolName, observation.success == null ? "" : observation.success ? "success" : "failed"].filter(Boolean).join(" | ")) + '</div>' +
          '<pre>' + esc(observation.content) + '</pre>' +
        '</div>'
      ).join("") || '<div class="muted">No observations yet.</div>';
    }
    async function selectRun(runId) {
      if (!runId) return;
      state.selectedRunId = runId;
      history.replaceState(null, "", "?run=" + encodeURIComponent(runId));
      const detail = await api("/run/" + encodeURIComponent(runId));
      $("detail").innerHTML =
        '<div class="row">' +
          '<div class="row-title">' + esc(detail.goal?.title ?? runId) + '</div>' +
          '<div class="row-meta">' + esc(detail.goal?.status ?? "unknown") + ' | ' + esc(detail.runUsage?.trigger ?? "n/a") + ' | tokens ' + esc(detail.runUsage?.totalTokens ?? "n/a") + '</div>' +
        '</div>' +
        '<div class="detail-grid"><div><h2>Events</h2><div id="detail-events" class="timeline"></div></div>' +
        '<div><h2>Observations</h2><div id="detail-observations" class="timeline"></div></div></div>';
      renderEvents(detail.events || [], $("detail-events"));
      renderObservations(detail.observations || [], $("detail-observations"));
    }
    async function refresh() {
      const data = await api("/snapshot");
      renderStats(data);
      renderRuns(data.recentRuns || []);
      renderGoals(data.goals || []);
      renderEvents(data.recentEvents || []);
      renderObservations(data.recentObservations || []);
      if (state.selectedRunId) await selectRun(state.selectedRunId);
    }
    async function postAction(path) {
      const result = await api(path, { method: "POST" });
      if (result.runId) state.selectedRunId = result.runId;
      await refresh();
    }
    $("refresh").addEventListener("click", () => refresh().catch((error) => alert(error.message)));
    $("pause").addEventListener("click", () => postAction("/pause").catch((error) => alert(error.message)));
    $("resume").addEventListener("click", () => postAction("/resume").catch((error) => alert(error.message)));
    $("wake").addEventListener("click", () => postAction("/start").catch((error) => alert(error.message)));
    refresh().catch((error) => {
      $("subtitle").textContent = error.message;
    });
  </script>
</body>
</html>`;
}

export function createCuriosityObservatoryRoute(params: ObservatoryRouteParams) {
  let manualRunInFlight = false;
  let lastManualRunId: string | undefined;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/curiosity", "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/curiosity";
    const manager = await params.resolveManager(params.workspaceDir);

    if (pathname === "/curiosity") {
      sendText(res, 200, observatoryHtml(), "text/html; charset=utf-8");
      return true;
    }

    if (pathname === "/curiosity/api/snapshot" && req.method === "GET") {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      sendJson(res, 200, await manager.observatorySnapshot(Number.isFinite(limit) ? limit : 50));
      return true;
    }

    if (pathname.startsWith("/curiosity/api/run/") && req.method === "GET") {
      const runId = decodeURIComponent(pathname.slice("/curiosity/api/run/".length));
      sendJson(res, 200, await manager.observatoryRunDetail(runId));
      return true;
    }

    if (pathname.startsWith("/curiosity/api/raw/") && req.method === "GET") {
      const rawId = Number.parseInt(decodeURIComponent(pathname.slice("/curiosity/api/raw/".length)), 10);
      if (!Number.isFinite(rawId)) {
        sendText(res, 400, "Invalid observation id");
        return true;
      }
      const content = await manager.readRawObservationContent(rawId);
      if (content == null) {
        sendText(res, 404, "Raw content not found");
        return true;
      }
      sendText(res, 200, content);
      return true;
    }

    if (pathname === "/curiosity/api/pause" && req.method === "POST") {
      await manager.setPaused(true);
      sendJson(res, 200, { paused: true });
      return true;
    }

    if (pathname === "/curiosity/api/resume" && req.method === "POST") {
      await manager.setPaused(false);
      sendJson(res, 200, { paused: false });
      return true;
    }

    if (pathname === "/curiosity/api/start" && req.method === "POST") {
      if (manualRunInFlight) {
        sendJson(res, 202, { started: false, inFlight: true, runId: lastManualRunId });
        return true;
      }
      const runId = `curiosity-observatory-${Date.now()}`;
      manualRunInFlight = true;
      lastManualRunId = runId;
      void executeCuriosityRun({
        manager,
        agentId: params.agentId,
        runId,
        timeoutSeconds: 900,
        gatewayUrl: params.gatewayUrl,
        runtimeConfig: params.runtimeConfig,
        select: true,
        notifyStart: false,
        trigger: "curiosity-observatory",
      })
        .then((result) => {
          params.logger.info?.(`curiosity: observatory run ${runId} finished selected=${String(result.selected)}`);
        })
        .catch((error) => {
          params.logger.warn?.(`curiosity: observatory run ${runId} failed (${String(error)})`);
        })
        .finally(() => {
          manualRunInFlight = false;
        });
      sendJson(res, 202, { started: true, runId });
      return true;
    }

    sendJson(res, 404, { error: "not_found" });
    return true;
  };
}
