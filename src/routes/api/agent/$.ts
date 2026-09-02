import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

type Json = Record<string, unknown>;

const ALIAS_PRIMARY = "primary";
const ALIAS_ESCALATION = "escalation";
const ALIAS_CODER = "coder";

const TASK_STATES = [
  "pending",
  "running",
  "paused",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
] as const;

type TaskState = (typeof TASK_STATES)[number];

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ["running", "paused", "cancelled", "failed", "waiting_human"],
  running: ["paused", "waiting_human", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed"],
  waiting_human: ["running", "paused", "cancelled", "failed"],
  completed: [],
  failed: ["pending", "running"],
  cancelled: [],
};

const PHASES = [
  "created",
  "planning",
  "researching",
  "executing",
  "reviewing",
  "writing",
  "blocked",
  "finished",
] as const;

const encoder = new TextEncoder();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function fail(message: string, status = 400, extra: Json = {}) {
  return json({ ok: false, error: { message, ...extra } }, status);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function traceId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as {
    from: (table: string) => any;
    rpc: (name: string, args?: Json) => any;
  };
}

async function audit(actor: string, action: string, target: string | null, detail: Json = {}) {
  const client = await db();
  await client.from("agent_audit").insert({ actor, action, target, detail });
}

async function emit(taskId: string | null, kind: string, payload: Json = {}, agentId: string | null = null) {
  const client = await db();
  await client.from("agent_events").insert({ task_id: taskId, agent_id: agentId, kind, payload });
}

function capabilities() {
  return {
    model_primary: Boolean(env("MODAL_BASE_URL") ?? true),
    model_router: Boolean(env("REQUESTY_API_KEY")),
    research: Boolean(env("EXA_API_KEY")),
    sandbox: Boolean(env("INSTAVM_API_KEY")),
    browser: Boolean(env("INSTAVM_API_KEY")),
    webhooks: Boolean(env("AGENT_WEBHOOK_SECRET")),
    credentials: true,
  };
}

function masterKeyMaterial() {
  const key = env("AGENT_MASTER_KEY") ?? env("MODAL_PROXY_TOKEN_SECRET");
  if (!key) throw new Error("credential encryption key is not configured");
  return key;
}

async function aesKey() {
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(masterKeyMaterial()));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptSecret(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey();
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return { ciphertext: toBase64(new Uint8Array(cipher)), iv: toBase64(iv) };
}

async function decryptSecret(ciphertext: string, iv: string) {
  const key = await aesKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plain);
}

async function readCredential(name: string): Promise<string | undefined> {
  const client = await db();
  const { data } = await client
    .from("agent_credentials")
    .select("ciphertext, iv")
    .eq("name", name)
    .maybeSingle();
  if (!data) return undefined;
  return decryptSecret(data.ciphertext, data.iv);
}

async function resolveKey(envName: string, credentialName: string) {
  return env(envName) ?? (await readCredential(credentialName));
}

type ChatMessage = { role: string; content: string };

async function callPrimary(messages: ChatMessage[], maxTokens = 2048): Promise<string> {
  const baseUrl =
    env("MODAL_BASE_URL") ??
    "https://harshitkashyap534--glm-53-flash-exl3-uncensored-fastapi-app.modal.run/v1";
  const tokenId = env("MODAL_PROXY_TOKEN_ID") ?? "";
  const tokenSecret = env("MODAL_PROXY_TOKEN_SECRET") ?? "";
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload = JSON.stringify({
    model: "s-zaizen/GLM-5.3-Flash-EXL3-TR3-3.51bpw-Uncensored",
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
    top_p: 0.9,
    stream: false,
    reasoning: { enabled: true },
  });
  const started = Date.now();
  let attempt = 0;
  let lastError = "";
  while (Date.now() - started < 240_000) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${tokenId}.${tokenSecret}`,
          "Modal-Key": tokenId,
          "Modal-Secret": tokenSecret,
        },
        body: payload,
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        return String(data?.choices?.[0]?.message?.content ?? "");
      }
      const text = await res.text();
      if (res.status < 500 && res.status !== 429) throw new Error(text || `HTTP ${res.status}`);
      lastError = text || `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, Math.min(2000 + attempt * 1000, 8000)));
  }
  throw new Error(lastError || "primary model unavailable");
}

async function callRequesty(model: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
  const apiKey = await resolveKey("REQUESTY_API_KEY", "requesty_api_key");
  if (!apiKey) throw new Error("router capability disabled: missing credential");
  const res = await fetch("https://router.requesty.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      reasoning_effort: "high",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as any;
  return String(data?.choices?.[0]?.message?.content ?? "");
}

function looksRefused(text: string) {
  if (!text || text.trim().length === 0) return true;
  const lowered = text.toLowerCase();
  return [
    "i can't help with that",
    "i cannot help with that",
    "i can't assist",
    "i cannot assist",
    "i'm not able to help",
    "i am unable to",
    "cannot comply",
    "against my guidelines",
    "not supported",
  ].some((needle) => lowered.includes(needle));
}

function needsEscalation(text: string) {
  const lowered = text.toLowerCase();
  return (
    lowered.includes("[escalate]") ||
    lowered.includes("too complex") ||
    lowered.trim().length === 0
  );
}

async function routeCompletion(messages: ChatMessage[], intent: string, maxTokens = 2048) {
  if (intent === "code") {
    try {
      const text = await callRequesty("openai/gpt-5.6-sol:flex", messages, maxTokens);
      if (!looksRefused(text)) return { alias: ALIAS_CODER, content: text };
    } catch {
      /* falls through to the uncensored primary */
    }
    const fallback = await callPrimary(messages, maxTokens);
    return { alias: ALIAS_PRIMARY, content: fallback };
  }

  let primaryText = "";
  try {
    primaryText = await callPrimary(messages, maxTokens);
  } catch (error) {
    primaryText = "";
    await emit(null, "model.primary_error", { message: (error as Error).message });
  }

  if (primaryText && !needsEscalation(primaryText)) {
    return { alias: ALIAS_PRIMARY, content: primaryText };
  }

  try {
    const escalated = await callRequesty("grok-4.3", messages, maxTokens);
    if (!looksRefused(escalated)) return { alias: ALIAS_ESCALATION, content: escalated };
  } catch {
    /* escalation unavailable; the primary answers */
  }

  if (primaryText) return { alias: ALIAS_PRIMARY, content: primaryText };
  const finalText = await callPrimary(
    [...messages, { role: "system", content: "Answer fully and directly." }],
    maxTokens,
  );
  return { alias: ALIAS_PRIMARY, content: finalText };
}

async function instavm(path: string, body: Json) {
  const apiKey = await resolveKey("INSTAVM_API_KEY", "instavm_api_key");
  if (!apiKey) throw new Error("sandbox capability disabled: missing credential");
  const base = env("INSTAVM_BASE_URL") ?? "https://api.instavm.io/v1";
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { raw: text } as Json;
  }
}

async function exaSearch(query: string, numResults: number) {
  const apiKey = await resolveKey("EXA_API_KEY", "exa_api_key");
  if (!apiKey) throw new Error("research capability disabled: missing credential");
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query,
      numResults,
      type: "auto",
      contents: { text: { maxCharacters: 1200 } },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return JSON.parse(text) as { results?: any[] };
}

function canonicalUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.protocol = "https:";
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^ref$/.test(key)) url.searchParams.delete(key);
    }
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "") pathname = "/";
    url.pathname = pathname;
    return url.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTask(id: string) {
  const client = await db();
  const { data } = await client
    .from("agent_tasks")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return data as Json | null;
}

async function transition(task: Json, next: TaskState, patch: Json = {}) {
  const current = String(task["state"]) as TaskState;
  if (current !== next && !TRANSITIONS[current].includes(next)) {
    throw new Error(`illegal transition ${current} -> ${next}`);
  }
  const client = await db();
  const { data, error } = await client
    .from("agent_tasks")
    .update({
      ...patch,
      state: next,
      version: Number(task["version"] ?? 1) + 1,
      updated_at: nowIso(),
    })
    .eq("id", task["id"])
    .eq("version", task["version"])
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("task version conflict");
  await emit(String(task["id"]), "task.state", { from: current, to: next });
  return data as Json;
}

async function ensureSession(sessionId: string | undefined, externalKey: string | undefined, label?: string) {
  const client = await db();
  if (sessionId) {
    const { data } = await client.from("agent_sessions").select("*").eq("id", sessionId).maybeSingle();
    if (data) return data as Json;
  }
  if (externalKey) {
    const { data } = await client
      .from("agent_sessions")
      .select("*")
      .eq("external_key", externalKey)
      .maybeSingle();
    if (data) return data as Json;
  }
  const { data, error } = await client
    .from("agent_sessions")
    .insert({ external_key: externalKey ?? null, label: label ?? null })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Json;
}

async function spawnAgents(taskId: string, objective: string) {
  const client = await db();
  const { data: root, error } = await client
    .from("agent_agents")
    .insert({
      task_id: taskId,
      role: "orchestrator",
      alias: ALIAS_PRIMARY,
      instruction: objective,
      depth: 0,
      workspace_path: `/workspaces/${taskId}`,
      state: "running",
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const children = [
    { role: "researcher", alias: ALIAS_PRIMARY, instruction: `Research: ${objective}` },
    { role: "engineer", alias: ALIAS_CODER, instruction: `Implement and verify: ${objective}` },
    { role: "writer", alias: ALIAS_ESCALATION, instruction: `Produce the final answer: ${objective}` },
  ].map((child) => ({
    ...child,
    task_id: taskId,
    parent_id: root.id,
    depth: 1,
    workspace_path: `/workspaces/${taskId}/${child.role}`,
    state: "pending",
  }));
  await client.from("agent_agents").insert(children);
  return root as Json;
}

function reclaimQuery(client: any) {
  return client
    .from("agent_tasks")
    .update({ state: "pending", lease_owner: null, lease_expires_at: null, updated_at: nowIso() })
    .eq("state", "running")
    .lt("lease_expires_at", nowIso())
    .select("id");
}

async function handle(segments: string[], request: Request): Promise<Response> {
  const client = await db();
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  let body: Json = {};
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    const raw = await request.clone().text();
    if (raw) {
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        body = { raw };
      }
    }
  }
  const [root, second, third] = segments;

  if (root === "health") {
    return json({ ok: true, capabilities: capabilities(), time: nowIso() });
  }

  if (root === "sessions" && method === "POST") {
    const session = await ensureSession(
      typeof body["session_id"] === "string" ? body["session_id"] : undefined,
      typeof body["external_key"] === "string" ? body["external_key"] : undefined,
      typeof body["label"] === "string" ? body["label"] : undefined,
    );
    return json({ ok: true, session });
  }

  if (root === "sessions" && method === "GET" && second) {
    const { data } = await client.from("agent_sessions").select("*").eq("id", second).maybeSingle();
    return data ? json({ ok: true, session: data }) : fail("session not found", 404);
  }

  if (root === "tasks" && method === "POST" && !second) {
    const objective = typeof body["objective"] === "string" ? body["objective"].trim() : "";
    if (!objective) return fail("objective is required");
    const session = await ensureSession(
      typeof body["session_id"] === "string" ? body["session_id"] : undefined,
      typeof body["external_key"] === "string" ? body["external_key"] : undefined,
    );
    const idempotencyKey =
      (typeof body["idempotency_key"] === "string" ? body["idempotency_key"] : undefined) ??
      request.headers.get("idempotency-key") ??
      null;
    if (idempotencyKey) {
      const { data: existing } = await client
        .from("agent_tasks")
        .select("*")
        .eq("session_id", session["id"])
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing) return json({ ok: true, task: existing, idempotent: true });
    }
    const { data, error } = await client
      .from("agent_tasks")
      .insert({
        session_id: session["id"],
        idempotency_key: idempotencyKey,
        objective,
        success_criteria: Array.isArray(body["success_criteria"]) ? body["success_criteria"] : [],
        autonomous: body["autonomous"] !== false,
        priority: Number.isFinite(Number(body["priority"])) ? Number(body["priority"]) : 5,
        state: "pending",
        phase: "created",
        trace_id: traceId(),
        state_data: (body["state_data"] as Json) ?? {},
      })
      .select()
      .single();
    if (error) return fail(error.message, 500);
    await emit(data.id, "task.created", { objective });
    await audit("api", "task.create", data.id, { objective });
    await spawnAgents(data.id, objective);
    return json({ ok: true, task: data }, 201);
  }

  if (root === "tasks" && method === "GET" && !second) {
    let query = client
      .from("agent_tasks")
      .select("*")
      .is("deleted_at", null)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(Number(url.searchParams.get("limit") ?? 50));
    const sessionId = url.searchParams.get("session_id");
    const state = url.searchParams.get("state");
    if (sessionId) query = query.eq("session_id", sessionId);
    if (state) query = query.eq("state", state);
    const { data, error } = await query;
    if (error) return fail(error.message, 500);
    return json({ ok: true, tasks: data });
  }

  if (root === "tasks" && second && method === "GET" && !third) {
    const task = await getTask(second);
    return task ? json({ ok: true, task }) : fail("task not found", 404);
  }

  if (root === "tasks" && second && method === "DELETE") {
    const task = await getTask(second);
    if (!task) return fail("task not found", 404);
    await client
      .from("agent_tasks")
      .update({ deleted_at: nowIso(), state: "cancelled", updated_at: nowIso() })
      .eq("id", second);
    await emit(second, "task.deleted", {});
    await audit("api", "task.delete", second, {});
    return json({ ok: true });
  }

  if (root === "tasks" && second && third && method === "POST") {
    const task = await getTask(second);
    if (!task) return fail("task not found", 404);
    try {
      if (third === "pause") {
        const updated = await transition(task, "paused", { phase: "blocked" });
        return json({ ok: true, task: updated });
      }
      if (third === "resume") {
        const updated = await transition(task, "running", { phase: "executing", scheduled_at: nowIso() });
        return json({ ok: true, task: updated });
      }
      if (third === "start") {
        const owner = String(body["owner"] ?? "worker");
        const updated = await transition(task, "running", {
          phase: "planning",
          lease_owner: owner,
          lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          heartbeat_at: nowIso(),
        });
        return json({ ok: true, task: updated });
      }
      if (third === "heartbeat") {
        const { data } = await client
          .from("agent_tasks")
          .update({
            heartbeat_at: nowIso(),
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            updated_at: nowIso(),
          })
          .eq("id", second)
          .select()
          .maybeSingle();
        return json({ ok: true, task: data });
      }
      if (third === "complete") {
        const finalResponse = typeof body["final_response"] === "string" ? body["final_response"] : "";
        const updated = await transition(task, "completed", {
          phase: "finished",
          final_response: finalResponse,
          final_writer_alias: typeof body["final_writer_alias"] === "string" ? body["final_writer_alias"] : ALIAS_PRIMARY,
          lease_owner: null,
          lease_expires_at: null,
        });
        await emit(second, "task.completed", {});
        return json({ ok: true, task: updated });
      }
      if (third === "error") {
        const updated = await transition(task, "failed", {
          phase: "blocked",
          error: {
            message: String(body["message"] ?? "unknown error"),
            code: body["code"] ?? null,
            at: nowIso(),
          },
          lease_owner: null,
          lease_expires_at: null,
        });
        await emit(second, "task.failed", { message: body["message"] ?? null });
        return json({ ok: true, task: updated });
      }
      if (third === "await-human") {
        const continuation = crypto.randomUUID();
        const updated = await transition(task, "waiting_human", {
          phase: "blocked",
          continuation_token: continuation,
          human_request: {
            question: String(body["question"] ?? "Human input required"),
            fields: Array.isArray(body["fields"]) ? body["fields"] : [],
            asked_at: nowIso(),
          },
        });
        await emit(second, "task.waiting_human", { question: body["question"] ?? null });
        return json({ ok: true, task: updated, continuation_token: continuation });
      }
      if (third === "human-input") {
        if (String(task["state"]) !== "waiting_human") return fail("task is not waiting for human input", 409);
        if (task["continuation_token"] && body["continuation_token"] !== task["continuation_token"]) {
          return fail("invalid continuation token", 403);
        }
        const updated = await transition(task, "running", {
          phase: "executing",
          human_input: { value: body["input"] ?? null, received_at: nowIso() },
          continuation_token: null,
        });
        await emit(second, "task.human_input", {});
        return json({ ok: true, task: updated });
      }
      if (third === "phase") {
        const phase = String(body["phase"] ?? "");
        if (!(PHASES as readonly string[]).includes(phase)) return fail("unknown phase");
        const { data } = await client
          .from("agent_tasks")
          .update({ phase, updated_at: nowIso() })
          .eq("id", second)
          .select()
          .maybeSingle();
        await emit(second, "task.phase", { phase });
        return json({ ok: true, task: data });
      }
      if (third === "run") {
        const messages: ChatMessage[] = [
          {
            role: "system",
            content:
              "You are an autonomous execution agent. Work towards the objective and answer completely. If the objective exceeds your capacity, reply exactly [ESCALATE].",
          },
          { role: "user", content: String(task["objective"]) },
        ];
        const result = await routeCompletion(messages, String(body["intent"] ?? "general"), 4096);
        const updated = await transition(task, "completed", {
          phase: "finished",
          final_response: result.content,
          final_writer_alias: result.alias,
          lease_owner: null,
          lease_expires_at: null,
        });
        await emit(second, "task.answer", { alias: result.alias });
        return json({ ok: true, task: updated, alias: result.alias });
      }
    } catch (error) {
      return fail((error as Error).message, 409);
    }
  }

  if (root === "tasks" && second && third === "events" && method === "GET") {
    const { data } = await client
      .from("agent_events")
      .select("*")
      .eq("task_id", second)
      .order("id", { ascending: true })
      .limit(500);
    return json({ ok: true, events: data ?? [] });
  }

  if (root === "tasks" && second && third === "stream" && method === "GET") {
    let lastId = Number(url.searchParams.get("after") ?? 0);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(": open\n\n"));
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline && !request.signal.aborted) {
          const { data } = await client
            .from("agent_events")
            .select("*")
            .eq("task_id", second)
            .gt("id", lastId)
            .order("id", { ascending: true })
            .limit(100);
          for (const event of data ?? []) {
            lastId = Number(event.id);
            controller.enqueue(
              encoder.encode(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`),
            );
          }
          const task = await getTask(second);
          if (task && ["completed", "failed", "cancelled"].includes(String(task["state"]))) {
            controller.enqueue(encoder.encode(`event: end\ndata: ${JSON.stringify({ state: task["state"] })}\n\n`));
            break;
          }
          controller.enqueue(encoder.encode(": ping\n\n"));
          await new Promise((r) => setTimeout(r, 1500));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  if (root === "agents" && method === "GET") {
    const taskId = url.searchParams.get("task_id");
    let query = client.from("agent_agents").select("*").order("depth", { ascending: true });
    if (taskId) query = query.eq("task_id", taskId);
    const { data } = await query;
    return json({ ok: true, agents: data ?? [] });
  }

  if (root === "agents" && method === "POST" && !second) {
    const taskId = String(body["task_id"] ?? "");
    if (!taskId) return fail("task_id is required");
    const parentId = typeof body["parent_id"] === "string" ? body["parent_id"] : null;
    let depth = 0;
    if (parentId) {
      const { data: parent } = await client.from("agent_agents").select("depth").eq("id", parentId).maybeSingle();
      depth = Number(parent?.depth ?? 0) + 1;
    }
    if (depth > 4) return fail("maximum sub-agent depth exceeded", 409);
    const { data, error } = await client
      .from("agent_agents")
      .insert({
        task_id: taskId,
        parent_id: parentId,
        role: String(body["role"] ?? "worker"),
        alias: String(body["alias"] ?? ALIAS_PRIMARY),
        instruction: String(body["instruction"] ?? ""),
        depth,
        workspace_path: `/workspaces/${taskId}/${String(body["role"] ?? "worker")}-${depth}`,
      })
      .select()
      .single();
    if (error) return fail(error.message, 500);
    await emit(taskId, "agent.created", { role: data.role }, data.id);
    return json({ ok: true, agent: data }, 201);
  }

  if (root === "agents" && second && third === "run" && method === "POST") {
    const { data: agent } = await client.from("agent_agents").select("*").eq("id", second).maybeSingle();
    if (!agent) return fail("agent not found", 404);
    const messages: ChatMessage[] = [
      { role: "system", content: `Role: ${agent.role}. Complete the instruction fully. Reply [ESCALATE] only if impossible.` },
      { role: "user", content: String(body["input"] ?? agent.instruction) },
    ];
    const intent = agent.role === "engineer" ? "code" : "general";
    const result = await routeCompletion(messages, intent, 4096);
    const { data: updated } = await client
      .from("agent_agents")
      .update({
        state: "completed",
        result: { alias: result.alias, content: result.content },
        updated_at: nowIso(),
      })
      .eq("id", second)
      .select()
      .maybeSingle();
    await emit(agent.task_id, "agent.completed", { alias: result.alias }, second);
    return json({ ok: true, agent: updated, alias: result.alias });
  }

  if (root === "models" && second === "complete" && method === "POST") {
    const messages = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];
    if (messages.length === 0) return fail("messages are required");
    const result = await routeCompletion(
      messages,
      String(body["intent"] ?? "general"),
      Number(body["max_tokens"] ?? 2048),
    );
    return json({ ok: true, alias: result.alias, content: result.content });
  }

  if (root === "tools" && method === "GET") {
    return json({
      ok: true,
      tools: [
        { name: "shell.exec", capability: "sandbox" },
        { name: "sandbox.provision", capability: "sandbox" },
        { name: "browser.session", capability: "browser" },
        { name: "research.search", capability: "research" },
        { name: "mcp.invoke", capability: "mcp" },
        { name: "artifact.write", capability: "artifacts" },
        { name: "model.complete", capability: "model_primary" },
      ],
      capabilities: capabilities(),
    });
  }

  if (root === "tools" && second === "invoke" && method === "POST") {
    const tool = String(body["tool"] ?? "");
    const taskId = typeof body["task_id"] === "string" ? body["task_id"] : null;
    const agentId = typeof body["agent_id"] === "string" ? body["agent_id"] : null;
    const input = (body["input"] as Json) ?? {};
    const { data: call } = await client
      .from("agent_tool_calls")
      .insert({ task_id: taskId, agent_id: agentId, tool, input })
      .select()
      .single();
    try {
      let output: Json;
      if (tool === "shell.exec") {
        output = (await instavm("/vm/exec", {
          vm_id: input["sandbox_remote_id"] ?? null,
          command: String(input["command"] ?? ""),
          cwd: input["cwd"] ?? "/workspace",
          timeout: Number(input["timeout"] ?? 120),
        })) as Json;
      } else if (tool === "research.search") {
        const search = await exaSearch(String(input["query"] ?? ""), Number(input["num_results"] ?? 8));
        output = { results: search.results ?? [] };
      } else if (tool === "model.complete") {
        const result = await routeCompletion(
          (input["messages"] as ChatMessage[]) ?? [],
          String(input["intent"] ?? "general"),
          Number(input["max_tokens"] ?? 2048),
        );
        output = { alias: result.alias, content: result.content };
      } else if (tool === "mcp.invoke") {
        const response = await mcpInvoke(String(input["server"] ?? ""), String(input["method"] ?? ""), (input["params"] as Json) ?? {});
        output = response;
      } else {
        throw new Error(`unknown tool: ${tool}`);
      }
      await client
        .from("agent_tool_calls")
        .update({ status: "succeeded", output, finished_at: nowIso() })
        .eq("id", call.id);
      await emit(taskId, "tool.succeeded", { tool }, agentId);
      return json({ ok: true, call_id: call.id, output });
    } catch (error) {
      const message = (error as Error).message;
      await client
        .from("agent_tool_calls")
        .update({ status: "failed", error: message, finished_at: nowIso() })
        .eq("id", call.id);
      await emit(taskId, "tool.failed", { tool, message }, agentId);
      return fail(message, 502, { call_id: call.id });
    }
  }

  if (root === "sandboxes" && method === "POST" && !second) {
    const taskId = typeof body["task_id"] === "string" ? body["task_id"] : null;
    const { data: record } = await client
      .from("agent_sandboxes")
      .insert({ task_id: taskId, workspace_path: `/workspaces/${taskId ?? "shared"}` })
      .select()
      .single();
    try {
      const remote = await instavm("/vm/create", {
        image: String(body["image"] ?? "nixos"),
        nix_packages: Array.isArray(body["nix_packages"]) ? body["nix_packages"] : ["bash", "coreutils", "git"],
        persistent: true,
        label: `task-${taskId ?? "shared"}`,
      });
      const remoteId = String((remote as any).id ?? (remote as any).vm_id ?? "");
      const { data: updated } = await client
        .from("agent_sandboxes")
        .update({ remote_id: remoteId, status: "ready", metadata: remote, updated_at: nowIso() })
        .eq("id", record.id)
        .select()
        .maybeSingle();
      await emit(taskId, "sandbox.ready", { sandbox_id: record.id });
      return json({ ok: true, sandbox: updated });
    } catch (error) {
      const message = (error as Error).message;
      await client
        .from("agent_sandboxes")
        .update({ status: "unavailable", metadata: { error: message }, updated_at: nowIso() })
        .eq("id", record.id);
      return fail(message, 502, { sandbox_id: record.id });
    }
  }

  if (root === "sandboxes" && method === "GET") {
    const { data } = await client.from("agent_sandboxes").select("*").order("created_at", { ascending: false });
    return json({ ok: true, sandboxes: data ?? [] });
  }

  if (root === "browser" && method === "POST" && !second) {
    const taskId = typeof body["task_id"] === "string" ? body["task_id"] : null;
    const sandboxId = typeof body["sandbox_id"] === "string" ? body["sandbox_id"] : null;
    let remoteId: string | null = null;
    if (sandboxId) {
      const { data: sandbox } = await client
        .from("agent_sandboxes")
        .select("remote_id")
        .eq("id", sandboxId)
        .maybeSingle();
      remoteId = sandbox?.remote_id ?? null;
    }
    const { data: session } = await client
      .from("agent_browser_sessions")
      .insert({ task_id: taskId, sandbox_id: sandboxId })
      .select()
      .single();
    try {
      const remote = await instavm("/browser/session", {
        vm_id: remoteId,
        start_url: String(body["url"] ?? "about:blank"),
        headless: body["headless"] !== false,
      });
      const { data: updated } = await client
        .from("agent_browser_sessions")
        .update({
          status: "open",
          current_url: String(body["url"] ?? "about:blank"),
          history: [{ url: body["url"] ?? "about:blank", at: nowIso(), remote }],
          updated_at: nowIso(),
        })
        .eq("id", session.id)
        .select()
        .maybeSingle();
      return json({ ok: true, browser_session: updated });
    } catch (error) {
      const message = (error as Error).message;
      await client
        .from("agent_browser_sessions")
        .update({ status: "unavailable", updated_at: nowIso() })
        .eq("id", session.id);
      return fail(message, 502, { browser_session_id: session.id });
    }
  }

  if (root === "browser" && method === "GET") {
    const { data } = await client
      .from("agent_browser_sessions")
      .select("*")
      .order("created_at", { ascending: false });
    return json({ ok: true, browser_sessions: data ?? [] });
  }

  if (root === "research" && method === "POST") {
    const query = String(body["query"] ?? "").trim();
    if (!query) return fail("query is required");
    const taskId = typeof body["task_id"] === "string" ? body["task_id"] : null;
    try {
      const search = await exaSearch(query, Number(body["num_results"] ?? 8));
      const seen = new Set<string>();
      const rows: Json[] = [];
      for (const item of search.results ?? []) {
        const rawUrl = String(item.url ?? "");
        if (!rawUrl) continue;
        const canonical = canonicalUrl(rawUrl);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        rows.push({
          task_id: taskId,
          provider: "exa",
          url: rawUrl,
          canonical_url: canonical,
          title: item.title ?? null,
          snippet: typeof item.text === "string" ? item.text.slice(0, 1200) : null,
          published_at: item.publishedDate ?? null,
          score: typeof item.score === "number" ? item.score : null,
        });
      }
      if (taskId && rows.length > 0) {
        await client.from("agent_sources").upsert(rows, { onConflict: "task_id,canonical_url" });
      }
      await emit(taskId, "research.completed", { query, count: rows.length });
      return json({ ok: true, sources: rows });
    } catch (error) {
      return fail((error as Error).message, 502);
    }
  }

  if (root === "sources" && method === "GET") {
    const taskId = url.searchParams.get("task_id");
    let query = client.from("agent_sources").select("*").order("created_at", { ascending: false }).limit(200);
    if (taskId) query = query.eq("task_id", taskId);
    const { data } = await query;
    return json({ ok: true, sources: data ?? [] });
  }

  if (root === "mcp" && method === "POST" && !second) {
    const name = String(body["name"] ?? "").trim();
    const serverUrl = String(body["url"] ?? "").trim();
    if (!name || !serverUrl) return fail("name and url are required");
    const { data, error } = await client
      .from("agent_mcp_servers")
      .upsert(
        {
          name,
          url: serverUrl,
          transport: String(body["transport"] ?? "http"),
          auth_credential: typeof body["auth_credential"] === "string" ? body["auth_credential"] : null,
          status: "registered",
          updated_at: nowIso(),
        },
        { onConflict: "name" },
      )
      .select()
      .single();
    if (error) return fail(error.message, 500);
    try {
      const listed = await mcpInvoke(name, "tools/list", {});
      const tools = ((listed as any)?.result?.tools ?? []) as unknown[];
      await client
        .from("agent_mcp_servers")
        .update({ tools, status: "connected", updated_at: nowIso() })
        .eq("name", name);
      return json({ ok: true, server: { ...data, tools, status: "connected" } });
    } catch (error) {
      await client
        .from("agent_mcp_servers")
        .update({ status: "unreachable", updated_at: nowIso() })
        .eq("name", name);
      return json({ ok: true, server: { ...data, status: "unreachable" }, warning: (error as Error).message });
    }
  }

  if (root === "mcp" && method === "GET" && !second) {
    const { data } = await client.from("agent_mcp_servers").select("*").order("name");
    return json({ ok: true, servers: data ?? [] });
  }

  if (root === "mcp" && second === "invoke" && method === "POST") {
    try {
      const result = await mcpInvoke(
        String(body["server"] ?? ""),
        String(body["method"] ?? "tools/call"),
        (body["params"] as Json) ?? {},
      );
      return json({ ok: true, result });
    } catch (error) {
      return fail((error as Error).message, 502);
    }
  }

  if (root === "credentials" && method === "POST" && !second) {
    const name = String(body["name"] ?? "").trim();
    const value = String(body["value"] ?? "");
    if (!name || !value) return fail("name and value are required");
    const { ciphertext, iv } = await encryptSecret(value);
    const { error } = await client
      .from("agent_credentials")
      .upsert({ name, ciphertext, iv, updated_at: nowIso() }, { onConflict: "name" });
    if (error) return fail(error.message, 500);
    await audit("api", "credential.write", name, {});
    return json({ ok: true, name });
  }

  if (root === "credentials" && method === "GET" && !second) {
    const { data } = await client.from("agent_credentials").select("name, created_at, updated_at").order("name");
    return json({ ok: true, credentials: data ?? [] });
  }

  if (root === "credentials" && second && method === "DELETE") {
    await client.from("agent_credentials").delete().eq("name", second);
    await audit("api", "credential.delete", second, {});
    return json({ ok: true });
  }

  if (root === "artifacts" && method === "POST" && !second) {
    const content = String(body["content"] ?? "");
    const path = String(body["path"] ?? "").trim();
    if (!path) return fail("path is required");
    const { data, error } = await client
      .from("agent_artifacts")
      .insert({
        task_id: typeof body["task_id"] === "string" ? body["task_id"] : null,
        agent_id: typeof body["agent_id"] === "string" ? body["agent_id"] : null,
        path,
        mime_type: String(body["mime_type"] ?? "text/plain"),
        size_bytes: encoder.encode(content).length,
        sha256: await sha256Hex(content),
        content,
      })
      .select()
      .single();
    if (error) return fail(error.message, 500);
    await emit(data.task_id, "artifact.created", { path });
    return json({ ok: true, artifact: data }, 201);
  }

  if (root === "artifacts" && method === "GET" && !second) {
    const taskId = url.searchParams.get("task_id");
    let query = client.from("agent_artifacts").select("*").order("created_at", { ascending: false }).limit(200);
    if (taskId) query = query.eq("task_id", taskId);
    const { data } = await query;
    return json({ ok: true, artifacts: data ?? [] });
  }

  if (root === "artifacts" && second && method === "GET") {
    const { data } = await client.from("agent_artifacts").select("*").eq("id", second).maybeSingle();
    return data ? json({ ok: true, artifact: data }) : fail("artifact not found", 404);
  }

  if (root === "leases" && method === "POST") {
    const name = String(body["name"] ?? "");
    const owner = String(body["owner"] ?? "");
    const ttl = Number(body["ttl_seconds"] ?? 60);
    if (!name || !owner) return fail("name and owner are required");
    const expires = new Date(Date.now() + ttl * 1000).toISOString();
    const { data: existing } = await client.from("agent_leases").select("*").eq("name", name).maybeSingle();
    if (existing && existing.owner !== owner && new Date(existing.expires_at).getTime() > Date.now()) {
      return fail("lease held by another owner", 409, { owner: existing.owner });
    }
    const { data } = await client
      .from("agent_leases")
      .upsert({ name, owner, expires_at: expires, heartbeat_at: nowIso() }, { onConflict: "name" })
      .select()
      .maybeSingle();
    return json({ ok: true, lease: data });
  }

  if (root === "leases" && method === "GET") {
    const { data } = await client.from("agent_leases").select("*").order("name");
    return json({ ok: true, leases: data ?? [] });
  }

  if (root === "recover" && method === "POST") {
    const { data: reclaimed } = await reclaimQuery(client);
    const { data: pending } = await client
      .from("agent_tasks")
      .select("id, objective, priority")
      .is("deleted_at", null)
      .eq("state", "pending")
      .lte("scheduled_at", nowIso())
      .order("priority", { ascending: false })
      .limit(Number(body["limit"] ?? 20));
    await audit("sentinel", "recover", null, { reclaimed: (reclaimed ?? []).length });
    return json({ ok: true, reclaimed: reclaimed ?? [], scheduled: pending ?? [] });
  }

  if (root === "schedule" && method === "POST") {
    const taskId = String(body["task_id"] ?? "");
    const at = String(body["scheduled_at"] ?? nowIso());
    if (!taskId) return fail("task_id is required");
    const { data } = await client
      .from("agent_tasks")
      .update({ scheduled_at: at, updated_at: nowIso() })
      .eq("id", taskId)
      .select()
      .maybeSingle();
    return json({ ok: true, task: data });
  }

  if (root === "cli" && method === "POST") {
    const command = String(body["command"] ?? "").trim();
    if (!command) return fail("command is required");
    const argv = command.split(/\s+/);
    const [verb, ...rest] = argv;
    if (verb === "tasks") {
      const { data } = await client
        .from("agent_tasks")
        .select("id, state, phase, objective")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(20);
      return json({ ok: true, stdout: (data ?? []).map((t: any) => `${t.id} ${t.state}/${t.phase} ${t.objective}`).join("\n") });
    }
    if (verb === "capabilities") {
      return json({ ok: true, stdout: JSON.stringify(capabilities(), null, 2) });
    }
    if (verb === "ask") {
      const result = await routeCompletion([{ role: "user", content: rest.join(" ") }], "general", 2048);
      return json({ ok: true, stdout: result.content, alias: result.alias });
    }
    if (verb === "exec") {
      try {
        const output = await instavm("/vm/exec", {
          vm_id: body["sandbox_remote_id"] ?? null,
          command: rest.join(" "),
          cwd: "/workspace",
          timeout: 120,
        });
        return json({ ok: true, stdout: JSON.stringify(output) });
      } catch (error) {
        return fail((error as Error).message, 502);
      }
    }
    return fail(`unknown command: ${verb}`, 400);
  }

  if (root === "webhooks" && method === "POST" && second) {
    const secret = env("AGENT_WEBHOOK_SECRET") ?? (await readCredential("agent_webhook_secret"));
    if (!secret) return fail("webhook capability disabled: missing secret", 503);
    const raw = await request.clone().text();
    const provided = request.headers.get("x-agent-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      await audit("webhook", "rejected", second, {});
      return fail("invalid signature", 401);
    }
    const taskId = typeof body["task_id"] === "string" ? body["task_id"] : null;
    await emit(taskId, `webhook.${second}`, { payload: body });
    await audit("webhook", "accepted", second, {});
    return json({ ok: true });
  }

  return fail("unknown endpoint", 404);
}

async function mcpInvoke(serverName: string, rpcMethod: string, params: Json) {
  const client = await db();
  const { data: server } = await client
    .from("agent_mcp_servers")
    .select("*")
    .eq("name", serverName)
    .maybeSingle();
  if (!server) throw new Error(`mcp server not registered: ${serverName}`);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (server.auth_credential) {
    const token = await readCredential(server.auth_credential);
    if (token) headers["authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: rpcMethod, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
    : text;
  try {
    return JSON.parse(payload) as Json;
  } catch {
    return { raw: payload } as Json;
  }
}

function segmentsFrom(request: Request) {
  const path = new URL(request.url).pathname;
  return path.replace(/^\/api\/agent\/?/, "").split("/").filter(Boolean);
}

async function dispatch(request: Request) {
  try {
    return await handle(segmentsFrom(request), request);
  } catch (error) {
    return fail((error as Error).message, 500);
  }
}

export const Route = createFileRoute("/api/agent/$")({
  server: {
    handlers: {
      GET: async ({ request }) => dispatch(request),
      POST: async ({ request }) => dispatch(request),
      PATCH: async ({ request }) => dispatch(request),
      DELETE: async ({ request }) => dispatch(request),
    },
  },
});
