import type { IncomingMessage, ServerResponse } from "node:http";

export const readJson = async <T>(request: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
};

export const readText = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
};

export const sendJson = (response: ServerResponse, status: number, payload: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  });
  response.end(JSON.stringify(payload));
};

export const sendText = (response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") => {
  response.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  });
  response.end(body);
};

export const notFound = (response: ServerResponse) => sendJson(response, 404, { error: "Not found" });
