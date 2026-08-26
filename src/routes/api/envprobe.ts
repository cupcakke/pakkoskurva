import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/envprobe")({
  server: {
    handlers: {
      GET: () =>
        Response.json({ keys: Object.keys(process.env ?? {}).slice(0, 60) }),
    },
  },
});
