// A stand-in for stable-diffusion.cpp's `sd-server`: takes its options, listens on --listen-port and answers the
// native job API Artel uses. FAKE_SD_MS: how long a picture takes. FAKE_SD_FAIL: a prompt with this word fails the job.
// GET /fake/args shows what it was started with; GET /fake/jobs what it was asked to draw. FAKE_SD_PORT_FILE: where to
// write the port once listening.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(option("--listen-port") ?? 1234);
const ms = Number(process.env.FAKE_SD_MS ?? 30);
// A one-pixel PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const jobs = new Map();
let next = 1;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req) =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (d) => (s += d)).on("end", () => resolve(s ? JSON.parse(s) : {}));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/fake/args") return json(res, 200, { args, pid: process.pid });
  if (url.pathname === "/fake/jobs") return json(res, 200, [...jobs.values()].map((j) => j.body));
  if (url.pathname === "/sdcpp/v1/capabilities") {
    return json(res, 200, { model: { name: option("--diffusion-model") }, supported_modes: ["img_gen"] });
  }
  if (req.method === "POST" && url.pathname === "/sdcpp/v1/img_gen") {
    const body = await read(req);
    const id = `job_${next++}`;
    const job = { id, body, status: "generating", started: Date.now(), result: null, error: null };
    jobs.set(id, job);
    setTimeout(() => {
      if (job.status !== "generating") return;
      if (process.env.FAKE_SD_FAIL && body.prompt.includes(process.env.FAKE_SD_FAIL)) {
        Object.assign(job, { status: "failed", error: { message: "out of memory" } });
      } else {
        Object.assign(job, { status: "completed", result: { output_format: "png", images: [{ index: 0, b64_json: PNG }] } });
      }
    }, ms);
    return json(res, 202, { id, kind: "img_gen", status: "queued", created: 0, poll_url: `/sdcpp/v1/jobs/${id}` });
  }
  const cancel = /^\/sdcpp\/v1\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (req.method === "POST" && cancel) {
    const job = jobs.get(cancel[1]);
    if (!job) return json(res, 404, {});
    job.status = "cancelled";
    return json(res, 200, { id: job.id, status: job.status });
  }
  const poll = /^\/sdcpp\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
  if (poll) {
    const job = jobs.get(poll[1]);
    if (!job) return json(res, 404, {});
    return json(res, 200, { id: job.id, kind: "img_gen", status: job.status, result: job.result, error: job.error, queue_position: 0 });
  }
  json(res, 404, {});
}).listen(port, option("--listen-ip") ?? "127.0.0.1", () => {
  if (process.env.FAKE_SD_PORT_FILE) writeFileSync(process.env.FAKE_SD_PORT_FILE, String(port));
});
