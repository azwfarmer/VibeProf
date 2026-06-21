import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { readJson, readText, sendJson, sendText, notFound } from "./http.js";
import { store } from "./storage/fileStore.js";
import { getModelStatuses } from "./ai/modelRegistry.js";
import { commandsToStrokes } from "./ai/drawingCommands.js";
import { getTutorResponse, voiceFallbackStatus } from "./ai/providers.js";
import { applyRealtimeCanvasCommands, createGeminiLiveToken, createOpenAiRealtimeSession, voiceStatus } from "./ai/voice.js";
import type { NotesState, Stroke, TutorMessageRequest } from "./types.js";

const frontendDistCandidates = [
  process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD, "apps/frontend/dist") : "",
  path.resolve(process.cwd(), "../../apps/frontend/dist"),
  path.resolve(process.cwd(), "../frontend/dist"),
  path.resolve(process.cwd(), "apps/frontend/dist")
].filter(Boolean);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pem": "application/x-pem-file",
  ".cer": "application/x-x509-ca-cert",
  ".crt": "application/x-x509-ca-cert",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const fileExists = async (filePath: string) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const sendFile = async (response: http.ServerResponse, filePath: string) => {
  const body = await fs.readFile(filePath);
  response.writeHead(200, {
    "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream"
  });
  response.end(body);
};

const serveFrontend = async (urlPathname: string, response: http.ServerResponse) => {
  const frontendDist = await Promise.all(
    frontendDistCandidates.map(async (candidate) => ({
      candidate,
      exists: await fileExists(path.join(candidate, "index.html"))
    }))
  ).then((candidates) => candidates.find((candidate) => candidate.exists)?.candidate);

  if (!frontendDist || !(await fileExists(path.join(frontendDist, "index.html")))) {
    notFound(response);
    return;
  }

  const requested = decodeURIComponent(urlPathname).replace(/^\/+/, "");
  const safeRequested = path.normalize(requested || "index.html");
  const candidate = path.resolve(frontendDist, safeRequested);
  const distRoot = path.resolve(frontendDist);

  if (!candidate.startsWith(distRoot)) {
    notFound(response);
    return;
  }

  if (await fileExists(candidate)) {
    await sendFile(response, candidate);
    return;
  }

  await sendFile(response, path.join(frontendDist, "index.html"));
};

const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/models/status") {
      sendJson(response, 200, { models: getModelStatuses(), voice: voiceFallbackStatus() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/voice/status") {
      sendJson(response, 200, voiceStatus());
      return;
    }

    if (method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, await store.getState());
      return;
    }

    if (method === "PUT" && url.pathname === "/api/state") {
      const body = await readJson<NotesState>(request);
      sendJson(response, 200, await store.replaceState(body));
      return;
    }

    const strokesMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/strokes$/);
    if (method === "PUT" && strokesMatch) {
      const body = await readJson<{ strokes: Stroke[] }>(request);
      sendJson(response, 200, await store.updatePageStrokes(strokesMatch[1], body.strokes ?? []));
      return;
    }

    const timelineMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/timeline$/);
    if (method === "GET" && timelineMatch) {
      sendJson(response, 200, { timeline: await store.getPageTimeline(timelineMatch[1]) });
      return;
    }

    const snapshotMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/snapshot$/);
    if (method === "POST" && snapshotMatch) {
      const body = await readJson<{ image: string }>(request);
      sendJson(response, 200, await store.saveSnapshot(snapshotMatch[1], body.image ?? ""));
      return;
    }

    if (method === "POST" && url.pathname === "/api/tutor/session") {
      const body = await readJson<{ pageId: string }>(request);
      sendJson(response, 200, await store.createSession(body.pageId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/voice/session/openai") {
      const sdp = await readText(request);
      const answer = await createOpenAiRealtimeSession(sdp);
      sendText(response, 200, answer, "application/sdp; charset=utf-8");
      return;
    }

    if (method === "POST" && url.pathname === "/api/voice/session/gemini") {
      sendJson(response, 200, await createGeminiLiveToken());
      return;
    }

    if (method === "POST" && url.pathname === "/api/voice/tools/apply-canvas-commands") {
      const body = await readJson<{ commands: unknown }>(request);
      sendJson(response, 200, applyRealtimeCanvasCommands(body.commands));
      return;
    }

    if (method === "POST" && url.pathname === "/api/tutor/message") {
      const body = await readJson<TutorMessageRequest>(request);
      const snapshot = body.snapshot ? body.snapshot : (await store.getSnapshot(body.pageId))?.image;
      const state = await store.getState();
      const storedPage = state.notebooks.flatMap((notebook) => notebook.pages).find((page) => page.id === body.pageId);
      const existingAiStrokes = body.aiStrokes?.length
        ? body.aiStrokes
        : storedPage?.strokes.filter((stroke) => stroke.source === "ai") ?? [];
      const strokeTimeline = await store.getPageTimeline(body.pageId);
      const tutor = await getTutorResponse({ ...body, snapshot, aiStrokes: existingAiStrokes, strokeTimeline });
      const newAiStrokes = commandsToStrokes(tutor.commands);
      sendJson(response, 200, { ...tutor, aiStrokes: newAiStrokes });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/tutor/realtime/")) {
      sendJson(response, 501, {
        error: "Realtime voice WebSocket is not enabled in this dependency-free build. Use /api/tutor/message fallback."
      });
      return;
    }

    if (method === "GET" || method === "HEAD") {
      await serveFrontend(url.pathname, response);
      return;
    }

    notFound(response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
};

const hasHttpsCerts =
  Boolean(config.https.certPath && config.https.keyPath) &&
  fsSync.existsSync(config.https.certPath) &&
  fsSync.existsSync(config.https.keyPath);

const httpsUrlFor = (request: http.IncomingMessage) => {
  const host = (request.headers.host ?? `localhost:${config.https.httpHelperPort}`).split(":")[0];
  return `https://${host}:${config.port}${request.url ?? "/"}`;
};

const handleHttpHelper = async (request: http.IncomingMessage, response: http.ServerResponse) => {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  const caDownloadPaths = new Set(["/local-ca.pem", "/local-ca.crt", "/local-ca.cer"]);

  if ((method === "GET" || method === "HEAD") && caDownloadPaths.has(url.pathname) && config.https.caCertPath && await fileExists(config.https.caCertPath)) {
    if (method === "HEAD") {
      response.writeHead(200, { "content-type": contentTypes[path.extname(url.pathname)] ?? contentTypes[".cer"] });
      response.end();
      return;
    }

    await sendFile(response, config.https.caCertPath);
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, httpsUrl: httpsUrlFor(request) });
    return;
  }

  const appUrl = httpsUrlFor(request);
  const certLink = config.https.caCertPath ? `<p><a href="/local-ca.cer">Download local CA certificate</a></p>` : "";

  sendText(
    response,
    200,
    `<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI Tutor HTTPS Setup</title></head>
  <body style="font-family: system-ui, sans-serif; line-height: 1.4; padding: 24px;">
    <h1>AI Tutor HTTPS Setup</h1>
    <p>iPad microphone access requires HTTPS for local-network apps.</p>
    ${certLink}
    <p>After trusting the certificate on the iPad, open <a href="${appUrl}">${appUrl}</a>.</p>
  </body>
</html>`,
    "text/html; charset=utf-8"
  );
};

// A socket can error before/while a request is parsed: a client speaking plain
// HTTP to the TLS port, a failed TLS handshake, or an abrupt reset. Node's default
// `clientError` handler then tries to write `400 Bad Request` to a socket that has
// already emitted an `error` event, which logs the "An error event has already been
// emitted on the socket" warning. Destroy the socket instead, as the warning advises.
const handleClientError = (error: NodeJS.ErrnoException, socket: import("node:net").Socket) => {
  if (socket.writable && error.code !== "ECONNRESET") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
  socket.destroy(error);
};

if (hasHttpsCerts) {
  const server = https.createServer(
      {
        cert: fsSync.readFileSync(config.https.certPath),
        key: fsSync.readFileSync(config.https.keyPath)
      },
      handle
    );

  server.on("clientError", handleClientError);

  server.listen(config.port, config.host, () => {
    console.log(`AI Tutor backend listening on https://${config.host}:${config.port}`);
  });

  if (config.https.httpHelperPort !== config.port) {
    const helperServer = http.createServer(handleHttpHelper);
    helperServer.on("clientError", handleClientError);
    helperServer.listen(config.https.httpHelperPort, config.host, () => {
      console.log(`AI Tutor HTTPS helper listening on http://${config.host}:${config.https.httpHelperPort}`);
    });
  }
} else {
  const server = http.createServer(handle);

  server.on("clientError", handleClientError);

  server.listen(config.port, config.host, () => {
    console.log(`AI Tutor backend listening on http://${config.host}:${config.port}`);
  });
}
