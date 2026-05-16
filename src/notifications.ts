import type { AutonomousStartNotificationConfig, GoalRecord } from "./types.js";

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type AutonomousStartNoticeResult =
  | { sent: true }
  | { sent: false; reason: "disabled" | "missing_telegram_config" | "rate_limited" | "delivery_failed" };

type SendAutonomousStartNoticeParams = {
  config: AutonomousStartNotificationConfig;
  goal: GoalRecord;
  agentId: string;
  runId: string;
  workspaceDir: string;
  now?: number;
  lastSentAt?: number | null;
  fetchFn?: typeof fetch;
  logger?: LoggerLike;
};

type SendAutonomousResultNoticeParams = {
  config: AutonomousStartNotificationConfig;
  goal: GoalRecord;
  agentId: string;
  runId: string;
  success: boolean;
  error?: string;
  summary?: string;
  fetchFn?: typeof fetch;
  logger?: LoggerLike;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clampLine(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function renderAutonomousStartNotice(params: {
  goal: GoalRecord;
  agentId: string;
  runId: string;
  workspaceDir: string;
  includeEvidence: boolean;
}): string {
  const score = params.goal.scoresByModel.active_ensemble.toFixed(3);
  const evidence = params.includeEvidence
    ? params.goal.evidence
        .slice(0, 2)
        .map((entry) => `\n- ${escapeHtml(clampLine(entry, 180))}`)
        .join("")
    : "";
  return [
    "<b>Curiosity is starting a run</b>",
    "",
    `<b>Drive signal</b>: ${escapeHtml(clampLine(params.goal.title, 220))}`,
    "<b>Expected action</b>: Author one bounded intention, act first with allowed tools, then report one concrete outcome or evidenced blocker.",
    "<b>Topic choice</b>: Use neutral opportunity selection; the drive signal is not the topic.",
    ...(evidence ? [`<b>Why now</b>:${evidence}`] : []),
    "",
    `<b>Details</b>: agent <code>${escapeHtml(params.agentId)}</code>, score <code>${score}</code>, surface <code>${escapeHtml(params.goal.targetSurface)}</code>`,
    `<b>Run</b>: <code>${escapeHtml(params.runId)}</code>`,
  ].join("\n");
}

export function renderAutonomousResultNotice(params: {
  goal: GoalRecord;
  agentId: string;
  runId: string;
  success: boolean;
  error?: string;
  summary?: string;
}): string {
  const status = params.success ? "completed" : "needs attention";
  const detail = params.success
    ? clampLine(params.summary || "The run completed.", 900)
    : clampLine(params.error || params.summary || "The run ended without a concrete outcome.", 900);
  return [
    `<b>Curiosity run ${escapeHtml(status)}</b>`,
    "",
    `<b>Drive signal</b>: ${escapeHtml(clampLine(params.goal.title, 220))}`,
    `<b>Result</b>: ${escapeHtml(detail)}`,
    "",
    `<b>Details</b>: agent <code>${escapeHtml(params.agentId)}</code>, surface <code>${escapeHtml(params.goal.targetSurface)}</code>`,
    `<b>Run</b>: <code>${escapeHtml(params.runId)}</code>`,
  ].join("\n");
}

function normalizeTelegramApiBaseUrl(raw: string | undefined): string {
  const base = raw?.trim() || "https://api.telegram.org";
  return base.replace(/\/+$/, "");
}

export async function sendAutonomousStartNotice(
  params: SendAutonomousStartNoticeParams,
): Promise<AutonomousStartNoticeResult> {
  const config = params.config;
  if (!config.enabled) {
    return { sent: false, reason: "disabled" };
  }
  const telegram = config.telegram;
  const botToken = telegram?.botToken?.trim();
  const chatId = telegram?.chatId?.trim();
  if (!botToken || !chatId) {
    params.logger?.warn?.("curiosity: autonomous-start notification skipped; Telegram botToken/chatId missing");
    return { sent: false, reason: "missing_telegram_config" };
  }
  const telegramConfig = telegram as NonNullable<AutonomousStartNotificationConfig["telegram"]>;

  const now = params.now ?? Date.now();
  const minIntervalMs = config.minIntervalMinutes * 60 * 1000;
  if (
    minIntervalMs > 0 &&
    typeof params.lastSentAt === "number" &&
    Number.isFinite(params.lastSentAt) &&
    now - params.lastSentAt < minIntervalMs
  ) {
    return { sent: false, reason: "rate_limited" };
  }

  const fetchImpl = params.fetchFn ?? globalThis.fetch;
  const url = `${normalizeTelegramApiBaseUrl(telegramConfig.apiBaseUrl)}/bot${encodeURIComponent(botToken)}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: renderAutonomousStartNotice({
      goal: params.goal,
      agentId: params.agentId,
      runId: params.runId,
      workspaceDir: params.workspaceDir,
      includeEvidence: config.includeEvidence,
    }),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    disable_notification: telegramConfig.disableNotification === true,
  };

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      params.logger?.warn?.(`curiosity: autonomous-start notification failed (${response.status})`);
      return { sent: false, reason: "delivery_failed" };
    }
    params.logger?.info?.("curiosity: autonomous-start notification sent via Telegram");
    return { sent: true };
  } catch (error) {
    params.logger?.warn?.(`curiosity: autonomous-start notification failed (${String(error)})`);
    return { sent: false, reason: "delivery_failed" };
  }
}

export async function sendAutonomousResultNotice(
  params: SendAutonomousResultNoticeParams,
): Promise<AutonomousStartNoticeResult> {
  const config = params.config;
  if (!config.enabled) {
    return { sent: false, reason: "disabled" };
  }
  const telegram = config.telegram;
  const botToken = telegram?.botToken?.trim();
  const chatId = telegram?.chatId?.trim();
  if (!botToken || !chatId) {
    params.logger?.warn?.("curiosity: autonomous-result notification skipped; Telegram botToken/chatId missing");
    return { sent: false, reason: "missing_telegram_config" };
  }
  const telegramConfig = telegram as NonNullable<AutonomousStartNotificationConfig["telegram"]>;
  const fetchImpl = params.fetchFn ?? globalThis.fetch;
  const url = `${normalizeTelegramApiBaseUrl(telegramConfig.apiBaseUrl)}/bot${encodeURIComponent(botToken)}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: renderAutonomousResultNotice({
      goal: params.goal,
      agentId: params.agentId,
      runId: params.runId,
      success: params.success,
      error: params.error,
      summary: params.summary,
    }),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    disable_notification: telegramConfig.disableNotification === true,
  };

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      params.logger?.warn?.(`curiosity: autonomous-result notification failed (${response.status})`);
      return { sent: false, reason: "delivery_failed" };
    }
    params.logger?.info?.("curiosity: autonomous-result notification sent via Telegram");
    return { sent: true };
  } catch (error) {
    params.logger?.warn?.(`curiosity: autonomous-result notification failed (${String(error)})`);
    return { sent: false, reason: "delivery_failed" };
  }
}
