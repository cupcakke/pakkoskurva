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
        const tokenId = process.env["MODAL_PROXY_TOKEN_ID"];
        const tokenSecret = process.env["MODAL_PROXY_TOKEN_SECRET"];
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

        let upstream: Response;
        try {
          upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: MODEL,
              messages: body.messages,
              temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
              top_p: typeof body.top_p === "number" ? body.top_p : 0.9,
              max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 2048,
              stream,
              reasoning: { enabled: true },
            }),
          });
        } catch (error) {
          return errorResponse(
            `Nem sikerült elérni a modellt: ${(error as Error).message}`,
            502,
          );
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          return errorResponse(text || `A modell hibát adott (${upstream.status}).`, upstream.status);
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
