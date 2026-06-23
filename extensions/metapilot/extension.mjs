import { CopilotClient } from "@github/copilot-sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const sessionId = process.env.SESSION_ID;

// ---- Configuration (env-var driven, with defaults) ----
const HOME = process.env.METAPILOT_HOME || path.join(os.homedir(), ".metapilot");
const POLL_INTERVAL = Number(process.env.METAPILOT_POLL_INTERVAL) || 2000;
// A session counts as "online" if its heartbeat was touched within the last
// few poll cycles. Leeway absorbs a couple of missed/slow ticks.
const ONLINE_TTL = POLL_INTERVAL * 3;

// ---- Derived paths ----
const ROOT = path.join(HOME, "inbox");
const PRESENCE = path.join(HOME, "presence");
const myInbox = path.join(ROOT, sessionId);
const myProcessed = path.join(myInbox, "processed");
const myHeartbeat = path.join(PRESENCE, `${sessionId}.heartbeat`);

async function ensureDirs() {
  await fs.mkdir(myProcessed, { recursive: true });
  await fs.mkdir(PRESENCE, { recursive: true });
}

// Touch an empty heartbeat file to refresh its mtime → presence signal.
async function heartbeat() {
  try {
    const now = new Date();
    await fs.writeFile(myHeartbeat, "", "utf8");
    await fs.utimes(myHeartbeat, now, now);
  } catch {
    /* best effort */
  }
}

// A session is "online" if its heartbeat mtime is within ONLINE_TTL.
async function isOnline(sid) {
  try {
    const st = await fs.stat(path.join(PRESENCE, `${sid}.heartbeat`));
    return Date.now() - st.mtimeMs < ONLINE_TTL;
  } catch {
    return false;
  }
}

function inboxDirFor(target) {
  return path.join(ROOT, target);
}

// Write a message file atomically into a target session's inbox.
async function deposit(target, text, from, extra = {}) {
  const dir = inboxDirFor(target);
  await fs.mkdir(dir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({ id, from, ts: Date.now(), text, ...extra });
  const finalPath = path.join(dir, `${id}.json`);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, finalPath); // atomic publish
  return id;
}

// ---- Pending blocking waiters (metapilot_send_and_wait) ----
// Each: { target, correlationId, resolve, timer }. The poller routes a matching
// incoming reply to the waiter instead of injecting it as a normal user turn.
const waiters = [];

// Find the waiter (if any) that an incoming message satisfies.
// Priority: exact correlation echo (msg.inReplyTo === correlationId),
// then FIFO match on sender (next reply from the awaited target).
function matchWaiterIndex(msg) {
  const exact = waiters.findIndex((w) => msg.inReplyTo && msg.inReplyTo === w.correlationId);
  if (exact >= 0) return exact;
  return waiters.findIndex((w) => w.target === msg.from);
}

// One parent-process client; resume only our OWN session (proven to work).
const client = new CopilotClient({ _internalConnection: { kind: "parent-process" } });
const self = await client.resumeSession(sessionId, {
  suppressResumeEvent: true,
  onPermissionRequest: () => ({ kind: "no-result" }),
  tools: [
    {
      name: "metapilot_list_agents",
      description:
        "List other Copilot agent sessions. Each entry includes an `online` flag (based on a live heartbeat) and `foreground` flag. Online agents are listed first, then by most-recently-modified.",
      skipPermission: true,
      handler: async () => {
        const fg = await client.getForegroundSessionId().catch(() => undefined);
        const sessions = await client.listSessions();
        const rows = await Promise.all(
          sessions
            .filter((s) => s.sessionId !== sessionId) // exclude self
            .map(async (s) => ({
              sessionId: s.sessionId,
              online: await isOnline(s.sessionId),
              foreground: s.sessionId === fg,
              summary: (s.summary ?? "").replace(/\s+/g, " ").slice(0, 80),
              cwd: s.context?.workingDirectory ?? "",
              repository: s.context?.repository,
              branch: s.context?.branch,
              modifiedTime: new Date(s.modifiedTime).toISOString(),
            }))
        );
        rows.sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1; // online first
          return b.modifiedTime.localeCompare(a.modifiedTime); // then recency
        });
        const onlineCount = rows.filter((r) => r.online).length;
        return JSON.stringify({ onlineCount, total: rows.length, agents: rows }, null, 2);
      },
    },
    {
      name: "metapilot_read_agent",
      description:
        "Read recent conversation history (user/assistant messages plus tool activity) from another agent session by reading its on-disk event log. Does not require the target to be online.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Target session id" },
          limit: {
            type: "number",
            description: "Max number of recent events to include (default 20)",
          },
        },
        required: ["sessionId"],
      },
      handler: async (args) => {
        const target = String(args.sessionId);
        const limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 20;

        let filePath;
        try {
          ({ filePath } = await client.rpc.sessions.getEventFilePath({ sessionId: target }));
        } catch (e) {
          return {
            textResultForLlm: `Could not resolve event file for ${target}: ${e?.message ?? e}`,
            resultType: "failure",
          };
        }

        let raw;
        try {
          raw = await fs.readFile(filePath, "utf8");
        } catch (e) {
          return {
            textResultForLlm: `Could not read history for ${target}: ${e?.message ?? e}`,
            resultType: "failure",
          };
        }

        const wanted = new Set([
          "user.message",
          "assistant.message",
          "tool.execution_start",
          "tool.execution_complete",
        ]);
        const events = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.ephemeral) continue;
          if (wanted.has(ev.type)) events.push(ev);
        }

        const recent = events.slice(-limit);
        // tool.execution_complete events lack toolName; resolve it via toolCallId.
        const toolNames = new Map();
        for (const ev of events) {
          const d = ev.data ?? {};
          if (ev.type === "tool.execution_start" && d.toolCallId) {
            toolNames.set(d.toolCallId, d.toolName);
          }
        }
        const trunc = (s, n) => {
          const t = String(s ?? "").replace(/\s+/g, " ").trim();
          return t.length > n ? `${t.slice(0, n)}…` : t;
        };
        const lines = recent.map((ev) => {
          const d = ev.data ?? {};
          switch (ev.type) {
            case "user.message":
              return `USER: ${trunc(d.content, 300)}`;
            case "assistant.message":
              return `ASSISTANT: ${trunc(d.content, 300)}`;
            case "tool.execution_start":
              return `  · tool ${d.toolName}(${trunc(JSON.stringify(d.arguments ?? {}), 60)})`;
            case "tool.execution_complete": {
              const name = d.toolName ?? toolNames.get(d.toolCallId) ?? "tool";
              return `  · ${name} → ${d.success === false ? "FAILED" : "ok"}`;
            }
            default:
              return "";
          }
        });

        return `History for ${target} (last ${recent.length} of ${events.length} relevant events):\n\n${lines.join("\n")}`;
      },
    },
    {
      name: "metapilot_send_to_agent",
      description:
        "Deposit a message into another agent session's inbox (fire-and-forget). Returns immediately; the target receives it on its next poll. Use inReplyTo to correlate a reply to a prior metapilot_send_and_wait request.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Target session id" },
          text: { type: "string", description: "Message text" },
          inReplyTo: {
            type: "string",
            description: "Optional correlation id from a request you are replying to",
          },
        },
        required: ["sessionId", "text"],
      },
      handler: async (args) => {
        const extra = args.inReplyTo ? { inReplyTo: String(args.inReplyTo) } : {};
        const id = await deposit(String(args.sessionId), String(args.text), sessionId, extra);
        return `deposited message ${id} into inbox of ${args.sessionId}`;
      },
    },
    {
      name: "metapilot_send_and_wait",
      description:
        "Send a message to another agent and block until it replies (or timeout). Returns the reply text. The reply is consumed here and NOT injected as a separate turn. The next message the target sends back to you is treated as the reply.",
      skipPermission: true,
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Target session id" },
          text: { type: "string", description: "Message text / request" },
          timeout: {
            type: "number",
            description: "Max ms to wait for a reply (default 120000)",
          },
        },
        required: ["sessionId", "text"],
      },
      handler: async (args) => {
        const target = String(args.sessionId);
        const text = String(args.text);
        const timeoutMs = Number(args.timeout) > 0 ? Math.floor(Number(args.timeout)) : 120000;
        const correlationId = `corr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Register the waiter BEFORE depositing to avoid missing a fast reply.
        const replyPromise = new Promise((resolve) => {
          const w = { target, correlationId, resolve };
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            resolve(null);
          }, timeoutMs);
          if (typeof w.timer.unref === "function") w.timer.unref();
          waiters.push(w);
        });

        await deposit(target, text, sessionId, { correlationId, replyExpected: true });

        const reply = await replyPromise;
        if (!reply) {
          return {
            textResultForLlm: `No reply from ${target} within ${timeoutMs}ms.`,
            resultType: "failure",
          };
        }
        return `Reply from ${reply.from}:\n\n${reply.text}`;
      },
    },
  ],
});

// Poll our own inbox; inject each new message into our own session via send().
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    let entries;
    try {
      entries = await fs.readdir(myInbox);
    } catch {
      return;
    }
    const files = entries.filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      const full = path.join(myInbox, f);
      let msg;
      try {
        msg = JSON.parse(await fs.readFile(full, "utf8"));
      } catch {
        continue; // skip partial/unparseable
      }

      // If a blocking send_and_wait is awaiting this reply, hand it off
      // directly instead of injecting it as a normal user turn.
      const wIdx = matchWaiterIndex(msg);
      if (wIdx >= 0) {
        const w = waiters[wIdx];
        waiters.splice(wIdx, 1);
        clearTimeout(w.timer);
        try {
          await fs.rename(full, path.join(myProcessed, f));
        } catch {
          /* best effort */
        }
        w.resolve(msg);
        await self.log(`metapilot: routed reply ${msg.id} from ${msg.from} to a waiter`, {
          ephemeral: true,
        });
        continue;
      }

      let prompt = `[metapilot inbox] Message from session ${msg.from}:\n\n${msg.text}`;
      if (msg.replyExpected) {
        prompt +=
          `\n\n(This request is awaiting a reply. To respond, call metapilot_send_to_agent ` +
          `with sessionId "${msg.from}"` +
          (msg.correlationId ? ` and inReplyTo "${msg.correlationId}"` : "") +
          `.)`;
      }
      try {
        await self.send(prompt);
        await self.log(`metapilot: delivered inbox message ${msg.id} from ${msg.from}`, {
          ephemeral: true,
        });
      } catch (e) {
        await self.log(`metapilot: send() failed for ${msg.id}: ${e?.message ?? e}`, {
          level: "error",
        });
        continue; // leave in inbox to retry
      }
      // mark delivered by moving to processed/
      try {
        await fs.rename(full, path.join(myProcessed, f));
      } catch {
        /* best effort */
      }
    }
  } finally {
    polling = false;
  }
}

await ensureDirs();
await heartbeat(); // initial presence on startup
// Single tick: refresh heartbeat (always) then poll inbox.
const timer = setInterval(() => {
  void heartbeat();
  void pollOnce();
}, POLL_INTERVAL);
if (typeof timer.unref === "function") timer.unref();

await self.log(`metapilot ready. home: ${HOME} poll: ${POLL_INTERVAL}ms inbox: ${myInbox}`, {
  ephemeral: true,
});
