import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";

export interface FakeProxy {
  url: string;
  port: number;
  /** Every request or tunnel that went through: its target and the Proxy-Authorization it carried. */
  hits: { target: string; auth: string | undefined }[];
  close(): Promise<void>;
}

/** An HTTP proxy for tests: tunnels CONNECT and forwards plain requests. Refuses wrong credentials when given some. */
export async function startFakeProxy(credentials?: { user: string; password: string }): Promise<FakeProxy> {
  const hits: FakeProxy["hits"] = [];
  const expected = credentials ? `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString("base64")}` : undefined;
  const allowed = (auth: string | undefined) => !expected || auth === expected;

  const server: Server = createServer((req, res) => {
    const auth = req.headers["proxy-authorization"];
    hits.push({ target: req.url ?? "", auth });
    if (!allowed(auth)) {
      res.writeHead(407, { "proxy-authenticate": "Basic" });
      return res.end();
    }
    const target = new URL(req.url ?? "");
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const upstream = request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
    const auth = req.headers["proxy-authorization"];
    hits.push({ target: req.url ?? "", auth });
    if (!allowed(auth)) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const cred = credentials ? `${credentials.user}:${credentials.password}@` : "";
  return {
    url: `http://${cred}127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
