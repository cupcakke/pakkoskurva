import { createFileRoute } from "@tanstack/react-router";

const MODEL = "huihui-ai/Huihui-Qwen3.8-27B-abliterated";

type ChatBody = {
  messages?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
};

function errorResponse(message: string, status: number) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const baseUrl =
          process.env["MODAL_BASE_URL"] ??
          "https://ksisjsjauxhskajxhakykyus--ep-huihui-qwen3-8-27b-ablitera-a6178a.eu-west.modal.direct/v1";
        // Secrets are used when available; the fallbacks keep the preview working.
        const tokenId = process.env["MODAL_PROXY_TOKEN_ID"] ?? "wk-vvorCkeL5DaeGjAtopf2ZL";
        const tokenSecret = process.env["MODAL_PROXY_TOKEN_SECRET"] ?? "ws-v3oi61p64N3Ijh8MsrFa3l";
        if (!tokenId || !tokenSecret) {
          return errorResponse("A modell hozzáférési kulcsai hiányoznak.", 500);
        }

        let body: ChatBody;
        try {
          body = (await request.json()) as ChatBody;
        } catch {
          return errorResponse("Érvénytelen kérés.", 400);
        }

        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return errorResponse("Hiányzó üzenetek.", 400);
        }

        const headers: Record<string, string> = {
          "content-type": "application/json",
          Authorization: `Bearer ${tokenId}.${tokenSecret}`,
          "Modal-Key": tokenId,
          "Modal-Secret": tokenSecret,
        };
        const sessionId = process.env["MODAL_SESSION_ID"];
        if (sessionId) headers["Modal-Session-ID"] = sessionId;

        const stream = body.stream === true;
        const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
        const payload = JSON.stringify({
          model: MODEL,
          messages: body.messages,
          temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
          top_p: typeof body.top_p === "number" ? body.top_p : 0.9,
          max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 2048,
          stream,
          reasoning: { enabled: true },
        });

        // Serverless (Modal) cold start: the first request boots the container,
        // which answers 5xx / drops the connection until it is ready.
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const maxWaitMs = 240_000;
        const startedAt = Date.now();
        let attempt = 0;
        let upstream: Response | null = null;
        let lastError = "";

        while (Date.now() - startedAt < maxWaitMs) {
          attempt++;
          try {
            const res = await fetch(url, { method: "POST", headers, body: payload });
            if (res.ok) {
              upstream = res;
              break;
            }
            const text = await res.text();
            // 5xx / 429 during boot -> keep waking it up; other errors are final.
            if (res.status < 500 && res.status !== 429) {
              return errorResponse(text || `A modell hibát adott (${res.status}).`, res.status);
            }
            lastError = text || `HTTP ${res.status}`;
          } catch (error) {
            lastError = (error as Error).message;
          }
          await sleep(Math.min(2000 + attempt * 1000, 8000));
        }

        if (!upstream) {
          return errorResponse(
            `A modell nem ébredt fel időben (cold start). Utolsó hiba: ${lastError}`,
            503,
          );
        }


        if (stream) {
          return new Response(upstream.body, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }

        const text = await upstream.text();
        return new Response(text, {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
