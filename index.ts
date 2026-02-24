/**
 * Sendblue iMessage Channel Plugin for OpenClaw
 *
 * iMessage send/receive via Sendblue REST API + webhooks.
 * Features:
 *   - Typing indicators fired before and during AI processing
 *   - Read receipts sent immediately on inbound message
 *   - Proper inbound routing through OpenClaw's dispatcher
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk";

const execFileAsync = promisify(execFile);

// ── Sendblue API helpers ──────────────────────────────────────────────

const SENDBLUE_BASE = "https://api.sendblue.co";

interface SendblueChannelConfig {
  apiKey: string;
  apiSecret: string;
  fromNumber: string;
  allowFrom: string[];
  webhookPath: string;
  webhookSecret: string;
  sendReadReceipts: boolean;
  sendTypingIndicators: boolean;
  typingIntervalMs: number;
  textChunkLimit: number;
  dmPolicy: string;
  enabled: boolean;
}

function resolveConfig(cfg: any): SendblueChannelConfig | null {
  const sb = cfg?.channels?.sendblue;
  if (!sb?.enabled) return null;
  return {
    apiKey: sb.apiKey ?? "",
    apiSecret: sb.apiSecret ?? "",
    fromNumber: sb.fromNumber ?? "",
    allowFrom: sb.allowFrom ?? [],
    webhookPath: normalizeWebhookPath(sb.webhookPath ?? "/webhooks/sendblue"),
    webhookSecret: sb.webhookSecret ?? "",
    sendReadReceipts: sb.sendReadReceipts !== false,
    sendTypingIndicators: sb.sendTypingIndicators !== false,
    typingIntervalMs: sb.typingIntervalMs ?? 50000,
    textChunkLimit: sb.textChunkLimit ?? 4000,
    dmPolicy: sb.dmPolicy ?? "allowlist",
    enabled: true,
  };
}

function normalizeWebhookPath(p: string): string {
  const trimmed = p.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function sbHeaders(config: SendblueChannelConfig) {
  return {
    "sb-api-key-id": config.apiKey,
    "sb-api-secret-key": config.apiSecret,
    "Content-Type": "application/json",
  };
}

async function sbPost(path: string, body: any, config: SendblueChannelConfig) {
  const url = `${SENDBLUE_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: sbHeaders(config),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function sbSendMessage(to: string, text: string, config: SendblueChannelConfig) {
  return sbPost("/api/send-message", {
    number: to,
    content: text,
    from_number: config.fromNumber,
  }, config);
}

async function sbSendTyping(to: string, config: SendblueChannelConfig) {
  return sbPost("/api/send-typing-indicator", {
    number: to,
    from_number: config.fromNumber,
  }, config);
}

async function sbMarkRead(to: string, config: SendblueChannelConfig) {
  return sbPost("/api/mark-read", {
    number: to,
    from_number: config.fromNumber,
  }, config);
}

// ── Typing indicator loop ──────────────────────────────────────────────

const activeTypingLoops = new Map<string, NodeJS.Timeout>();

function startTypingLoop(to: string, config: SendblueChannelConfig, log: any) {
  stopTypingLoop(to);
  // Fire immediately
  sbSendTyping(to, config).catch((e: any) =>
    log.warn(`[sendblue] typing indicator failed: ${e.message}`)
  );
  // Re-fire on interval (typing bubble expires ~60s in iMessage)
  const interval = setInterval(() => {
    sbSendTyping(to, config).catch((e: any) =>
      log.warn(`[sendblue] typing refresh failed: ${e.message}`)
    );
  }, config.typingIntervalMs);
  activeTypingLoops.set(to, interval);
}

function stopTypingLoop(to: string) {
  const existing = activeTypingLoops.get(to);
  if (existing) {
    clearInterval(existing);
    activeTypingLoops.delete(to);
  }
}

// ── Normalize phone numbers for comparison ─────────────────────────────

function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, "");
}

function isAllowedSender(sender: string, allowFrom: string[]): boolean {
  const normalized = normalizePhone(sender);
  return allowFrom.some((a) => normalizePhone(a) === normalized);
}

// ── HEIC media conversion ──────────────────────────────────────────────

const HEIC_CONVERTER = path.join(path.dirname(new URL(import.meta.url).pathname), "heic-convert.py");

async function convertMediaIfHeic(
  mediaUrl: string,
  log: any
): Promise<{ localPath: string; converted: boolean } | null> {
  if (!mediaUrl) return null;

  try {
    const tmpDir = path.join(os.tmpdir(), "sendblue-media");
    fs.mkdirSync(tmpDir, { recursive: true });

    const outputFile = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);

    const { stdout, stderr } = await execFileAsync("python3", [
      HEIC_CONVERTER, mediaUrl, outputFile,
    ], { timeout: 30000 });

    const resultPath = stdout.trim();
    if (resultPath && fs.existsSync(resultPath)) {
      const isHeic = mediaUrl.toLowerCase().includes("heic") ||
        mediaUrl.toLowerCase().includes("heif") ||
        resultPath !== mediaUrl;
      log.info(`[sendblue] media converted: ${mediaUrl} → ${resultPath}`);
      return { localPath: resultPath, converted: true };
    }

    if (stderr) log.warn(`[sendblue] heic-convert stderr: ${stderr}`);
    return null;
  } catch (e: any) {
    log.warn(`[sendblue] media conversion failed: ${e.message}`);
    return null;
  }
}

// ── Plugin registration ────────────────────────────────────────────────

const plugin = {
  id: "sendblue",
  name: "Sendblue iMessage",
  description: "iMessage channel via Sendblue API with typing indicators and read receipts",
  configSchema: { type: "object", additionalProperties: false, properties: {} },

  register(api: OpenClawPluginApi) {
    const log = api.logger;
    const runtime = api.runtime;

    // ── Channel plugin definition ──

    const channelPlugin = {
      id: "sendblue" as const,
      meta: {
        id: "sendblue" as const,
        label: "Sendblue (iMessage)",
        selectionLabel: "Sendblue iMessage API",
        docsPath: "/channels/sendblue",
        blurb: "iMessage via Sendblue API with typing indicators and read receipts.",
        aliases: ["sb"],
      },
      capabilities: {
        chatTypes: ["direct" as const],
      },
      config: {
        listAccountIds: (_cfg: any) => ["default"],
        resolveAccount: (cfg: any, _accountId?: string | null) => {
          const sb = cfg?.channels?.sendblue;
          return { accountId: "default", ...(sb ?? {}) };
        },
        isEnabled: (_account: any, cfg: any) => cfg?.channels?.sendblue?.enabled === true,
        isConfigured: (_account: any, cfg: any) =>
          Boolean(cfg?.channels?.sendblue?.apiKey && cfg?.channels?.sendblue?.fromNumber),
      },
      outbound: {
        deliveryMode: "direct" as const,
        sendText: async ({ text, to, cfg }: any) => {
          const config = resolveConfig(cfg);
          if (!config) return { ok: false, error: "sendblue not configured" };

          const target = to ?? config.allowFrom[0];
          if (!target) return { ok: false, error: "no target number" };

          // Stop typing loop — we're sending now
          stopTypingLoop(target);

          const result = await sbSendMessage(target, text, config);
          if (result.status >= 400) {
            log.error(`[sendblue] send failed: ${JSON.stringify(result.data)}`);
            return { ok: false, error: result.data?.message ?? "send failed" };
          }
          return { ok: true };
        },
      },
      security: {
        resolveDmPolicy: ({ cfg }: any) => ({
          policy: cfg?.channels?.sendblue?.dmPolicy ?? "allowlist",
          allowFrom: cfg?.channels?.sendblue?.allowFrom ?? [],
          allowFromPath: "channels.sendblue.allowFrom",
          approveHint: "Add the phone number to channels.sendblue.allowFrom",
        }),
      },
      gateway: {
        startAccount: async (ctx: any) => {
          log.info(`[sendblue] channel started (from: ${ctx.account?.fromNumber ?? "?"})`);
          // Keep the channel "alive" — resolve only when abort signal fires
          return new Promise<void>((resolve) => {
            const stop = () => {
              // Clean up typing loops
              for (const [key] of activeTypingLoops) {
                stopTypingLoop(key);
              }
              log.info("[sendblue] channel stopped");
              resolve();
            };
            if (ctx.abortSignal?.aborted) {
              stop();
              return;
            }
            ctx.abortSignal?.addEventListener("abort", stop, { once: true });
          });
        },
      },
      status: {
        buildAccountSnapshot: ({ account, cfg }: any) => ({
          accountId: "default",
          enabled: cfg?.channels?.sendblue?.enabled === true,
          configured: Boolean(cfg?.channels?.sendblue?.apiKey),
          dmPolicy: cfg?.channels?.sendblue?.dmPolicy ?? "allowlist",
          allowFrom: cfg?.channels?.sendblue?.allowFrom ?? [],
        }),
      },
    };

    api.registerChannel({ plugin: channelPlugin });

    // ── Webhook HTTP handler ──

    api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const cfg = api.config;
      const config = resolveConfig(cfg);
      if (!config) return false;

      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // Only handle our webhook path
      if (pathname !== config.webhookPath) return false;

      // Only accept POST
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return true;
      }

      // Read body
      let body: any;
      try {
        const rawBody = await readRequestBodyWithLimit(req, { maxBytes: 512 * 1024, timeoutMs: 10000 });
        body = JSON.parse(rawBody);
      } catch (e: any) {
        res.statusCode = 400;
        res.end("Invalid body");
        return true;
      }

      if (!body || typeof body !== "object") {
        res.statusCode = 400;
        res.end("Invalid JSON");
        return true;
      }

      // Verify webhook secret if configured
      if (config.webhookSecret) {
        const provided =
          req.headers["x-webhook-secret"] ??
          url.searchParams.get("secret") ??
          body.secret;
        const secret = Array.isArray(provided) ? provided[0] : provided;
        if (secret !== config.webhookSecret) {
          res.statusCode = 401;
          res.end("Unauthorized");
          log.warn("[sendblue] webhook rejected: bad secret");
          return true;
        }
      }

      // Determine event type
      const isTypingEvent = body.is_typing !== undefined;
      const isInbound = body.is_outbound === false || body.status === "RECEIVED";

      if (isTypingEvent) {
        log.info(`[sendblue] ${body.number} ${body.is_typing ? "typing..." : "stopped typing"}`);
        res.statusCode = 200;
        res.end("OK");
        return true;
      }

      if (body.is_outbound === true) {
        // Outbound status update
        log.info(`[sendblue] outbound ${body.message_handle} → ${body.status}`);
        res.statusCode = 200;
        res.end("OK");
        return true;
      }

      if (!isInbound || !body.content?.trim()) {
        res.statusCode = 200;
        res.end("OK");
        return true;
      }

      // ── Inbound message processing ──

      const senderNumber = body.from_number ?? body.number;
      const messageText = body.content.trim();

      // Check allowlist
      if (config.dmPolicy === "allowlist" && !isAllowedSender(senderNumber, config.allowFrom)) {
        log.warn(`[sendblue] rejected from ${senderNumber} (not in allowFrom)`);
        res.statusCode = 200;
        res.end("OK");
        return true;
      }

      // 1) Send read receipt immediately (async, don't block)
      if (config.sendReadReceipts) {
        sbMarkRead(senderNumber, config).catch((e: any) =>
          log.warn(`[sendblue] read receipt failed: ${e.message}`)
        );
      }

      // 2) Start typing indicator loop
      if (config.sendTypingIndicators) {
        startTypingLoop(senderNumber, config, log);
      }

      // 3) Convert HEIC media if present
      let mediaUrl = body.media_url || undefined;
      let mediaPath: string | undefined;
      if (mediaUrl) {
        const converted = await convertMediaIfHeic(mediaUrl, log);
        if (converted) {
          mediaPath = converted.localPath;
          mediaUrl = converted.localPath;  // Use local path for agent
        }
      }

      // 4) Route to agent via OpenClaw's dispatch system
      try {
        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "sendblue",
          accountId: "default",
          peer: { kind: "direct", id: senderNumber },
        });

        const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });
        const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
        const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
          storePath,
          sessionKey: route.sessionKey,
        });

        const body_ = runtime.channel.reply.formatInboundEnvelope({
          channel: "Sendblue",
          from: senderNumber,
          timestamp: body.date_sent ? new Date(body.date_sent).getTime() : undefined,
          previousTimestamp,
          envelope: envelopeOptions,
          body: messageText,
          chatType: "direct",
          sender: { name: undefined, id: senderNumber },
        });

        const outboundTarget = senderNumber;

        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body_,
          BodyForAgent: messageText,
          RawBody: messageText,
          CommandBody: messageText,
          BodyForCommands: messageText,
          MediaUrl: mediaUrl,
          MediaPath: mediaPath,
          MediaPaths: mediaPath ? [mediaPath] : undefined,
          From: `sendblue:${senderNumber}`,
          To: `sendblue:${outboundTarget}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "direct",
          ConversationLabel: senderNumber,
          Provider: "sendblue",
          Surface: "sendblue",
          MessageSid: body.message_handle,
          MessageSidFull: body.message_handle,
          Timestamp: body.date_sent ? new Date(body.date_sent).getTime() : Date.now(),
          OriginatingChannel: "sendblue",
          OriginatingTo: `sendblue:${outboundTarget}`,
          WasMentioned: true,
          CommandAuthorized: isAllowedSender(senderNumber, config.allowFrom),
        });

        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (payload: any) => {
              const text = payload.text ?? "";
              if (!text.trim()) return;

              // Stop typing since we're about to send
              stopTypingLoop(outboundTarget);

              const result = await sbSendMessage(outboundTarget, text, config);
              if (result.status >= 400) {
                log.error(`[sendblue] deliver failed: ${JSON.stringify(result.data)}`);
              }
            },
            onComplete: () => {
              stopTypingLoop(outboundTarget);
            },
          },
        });
      } catch (err: any) {
        log.error(`[sendblue] dispatch failed: ${err.message}`);
        stopTypingLoop(senderNumber);
      }

      // Respond to webhook immediately
      res.statusCode = 200;
      res.end("OK");
      return true;
    });

    // ── Gateway RPC method for status ──

    api.registerGatewayMethod("sendblue.status", ({ respond }: any) => {
      const config = resolveConfig(api.config);
      respond(true, {
        configured: !!config,
        fromNumber: config?.fromNumber ?? null,
        allowFrom: config?.allowFrom ?? [],
        readReceipts: config?.sendReadReceipts ?? true,
        typingIndicators: config?.sendTypingIndicators ?? true,
      });
    });

    log.info("[sendblue] plugin registered");
  },
};

export default plugin;
