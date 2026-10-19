// Live check of pictures and clips on this computer (docs/specs/local-images.md): the real engine and real models from
// Hugging Face, through the real core API. `npm run live-local-media -- --model=z-image-turbo` downloads the model
// (gigabytes: once, into .live-local/), draws a picture and saves it next to the log. The proxy from ARTEL_PROXY is used
// when Hugging Face cannot be reached directly.
import { startServer } from "@artel/core";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const modelId = arg("model") ?? "z-image-turbo";
const prompt = arg("prompt") ?? "A red fox in a knitted scarf sitting in snowy birch forest, soft morning light, photo";
const kind = arg("kind") === "video" ? "video" : "image";

// One folder for every run: what was downloaded once stays for the next.
const dataDir = join(process.cwd(), ".live-local");
mkdirSync(dataDir, { recursive: true });
const token = randomBytes(16).toString("hex");
const server = await startServer({ token, secretKey: randomBytes(32), dataDir, version: "live" });
const base = `http://127.0.0.1:${server.port}/api`;
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const log = (...p: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...p);
const gb = (n: number) => (n / 2 ** 30).toFixed(2);

try {
  if (process.env.ARTEL_PROXY) await api("PUT", "/proxy", { url: process.env.ARTEL_PROXY });
  const statusPath = kind === "video" ? "/local/videos" : "/local/images";
  let s = (await api("GET", statusPath)).body;
  log("status:", JSON.stringify({ supported: s.supported, engine: s.engine, models: s.models.map((m: any) => [m.id, m.fit, gb(m.sizeBytes), m.installed]) }));
  const model = () => s.models.find((m: any) => m.id === modelId);
  if (!model()) throw new Error(`${modelId} is not offered for this computer`);
  if (!model().installed) {
    const started = Date.now();
    await api("POST", `${statusPath}/pulls`, { model: modelId });
    let shown = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      s = (await api("GET", statusPath)).body;
      const p = model().pull;
      if (Date.now() - shown > 30_000 || p?.done) {
        shown = Date.now();
        log("pull:", p?.status, `${gb(p?.completed ?? 0)} of ${gb(p?.total ?? 0)} GB`, p?.bytesPerSecond ? `${(p.bytesPerSecond / 2 ** 20).toFixed(1)} MB/s` : "", p?.error ?? "");
      }
      if (p?.done) break;
    }
    if (!model().installed) throw new Error(`download failed: ${model().pull?.error}`);
    log(`downloaded in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
  }

  const providerId = s.providerId;
  const chat = (await api("POST", "/chats", { providerId, model: modelId, kind })).body;
  for (const [i, text] of [prompt, `${prompt}, second take`].entries()) {
    const started = Date.now();
    const res = await fetch(`${base}/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, options: { aspectRatio: "1:1" }, confirm: true }),
    });
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    const done = events.find((e) => e.type === "done")?.message;
    log(`${kind} ${i + 1}: ${done?.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`, done?.error ? JSON.stringify(done.error) : "");
    for (const m of done?.media ?? []) {
      const file = await fetch(`${base}/media/${m.id}/content`, { headers: { Authorization: `Bearer ${token}` } });
      const out = join(dataDir, `${modelId}-${i + 1}.${m.mime.split("/")[1]}`);
      writeFileSync(out, Buffer.from(await file.arrayBuffer()));
      log("saved", out);
    }
  }
} finally {
  await server.close();
}
