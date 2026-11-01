import { tool, type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { Workspace } from "../agent/workspace";
import { localAudio } from "../local/audio/service";
import { ffmpeg, runFfmpeg } from "./ffmpeg";
import { toolRunner } from "./run";

const kb = (path: string) => `${Math.max(1, Math.round(statSync(path).size / 1024))} KB`;
const tail = (log: string) => log.trim().split("\n").slice(-6).join("\n");

/**
 * Audio and video in the folder (docs/specs/tools.md, asked for): speech written down as text or subtitles by the
 * speech engine on this computer, and ffmpeg's everyday jobs — cut, join, shrink, convert, a frame, the sound, what is
 * inside. ffmpeg is the computer's own or downloaded once.
 */
export function mediaTools(dataDir: string, ws: Workspace, hooks: Pick<ToolHooks, "onCall">): ToolSet {
  const run = toolRunner(hooks);
  const input = (path: string) => {
    const full = ws.resolve(path);
    if (!existsSync(full)) throw new Error(`No file ${path}`);
    return full;
  };
  const output = (path: string) => {
    const full = ws.resolve(path);
    mkdirSync(dirname(full), { recursive: true });
    return full;
  };

  return {
    transcribe_media: tool({
      description:
        "Write down the speech of an audio or video file in the folder (a meeting, a lecture, an interview) with the speech engine on this computer, free and offline. subtitles: true also saves an .srt file next to it. Needs a speech model downloaded in Local models → Audio.",
      inputSchema: z.object({ path: z.string().min(1), subtitles: z.boolean().optional() }),
      execute: ({ path, subtitles }, o: { abortSignal?: AbortSignal }) =>
        run("transcribe_media", path, async () => {
          const audio = localAudio();
          if (!audio) throw new Error("The speech engine is not set up on this computer.");
          const src = input(path);
          const exe = await ffmpeg(dataDir);
          const wav = join(tmpdir(), `drimvox-${randomUUID()}.wav`);
          try {
            const conv = await runFfmpeg(exe, ["-y", "-i", src, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 30 * 60_000, o.abortSignal);
            if (conv.code !== 0 || !existsSync(wav)) throw new Error(`ffmpeg could not read the file:\n${tail(conv.log)}`);
            const done = await audio.transcribeFile(wav, !!subtitles);
            let saved = "";
            if (subtitles && done.srt) {
              const srt = join(dirname(path), `${basename(path, extname(path))}.srt`);
              writeFileSync(output(srt), done.srt);
              saved = `\nSubtitles saved: ${srt}`;
            }
            return `Written down by ${done.model}:${saved}\n\n${done.text || "(no speech heard)"}`;
          } finally {
            rmSync(wav, { force: true });
          }
        }),
    }),
    media_edit: tool({
      description:
        "Work with audio and video files in the folder through ffmpeg: info (what is inside), trim (start/end like 00:01:30), join (several files into one), compress (smaller video for the web), convert (to the output's format, such as .mp4, .webm, .mp3, .gif), frame (a picture at a moment), audio (the sound only).",
      inputSchema: z.object({
        action: z.enum(["info", "trim", "join", "compress", "convert", "frame", "audio"]),
        input: z.string().min(1).describe("The file in the folder"),
        inputs: z.array(z.string().min(1)).max(50).optional().describe("For join: the files in order (input is the first)"),
        output: z.string().optional().describe("Where to save, inside the folder (not for info)"),
        start: z.string().optional().describe("For trim: from, such as 00:00:05"),
        end: z.string().optional().describe("For trim: to"),
        at: z.string().optional().describe("For frame: the moment, such as 00:00:10"),
        width: z.number().int().min(16).max(7680).optional().describe("For compress, convert to .gif, frame: the width in pixels"),
      }),
      execute: (a, o: { abortSignal?: AbortSignal }) =>
        run("media_edit", `${a.action} ${a.input}`, async () => {
          const exe = await ffmpeg(dataDir);
          const src = input(a.input);
          if (a.action === "info") {
            const r = await runFfmpeg(exe, ["-i", src], 60_000, o.abortSignal);
            return r.log.split("\n").filter((l) => /Duration|Stream|Input #/.test(l)).join("\n").trim() || tail(r.log);
          }
          if (!a.output) throw new Error("Say where to save the result (output).");
          const out = output(a.output);
          const scale = a.width ? ["-vf", `scale=${a.width}:-2`] : [];
          let args: string[];
          let cleanup: string | null = null;
          switch (a.action) {
            case "trim":
              args = ["-y", ...(a.start ? ["-ss", a.start] : []), ...(a.end ? ["-to", a.end] : []), "-i", src, "-c", "copy", out];
              // -ss/-to before -i count from the start of the file for -to as well only with copy; good enough for cuts.
              break;
            case "join": {
              const list = [a.input, ...(a.inputs ?? []).filter((p) => p !== a.input)].map(input);
              const file = join(tmpdir(), `drimvox-${randomUUID()}.txt`);
              writeFileSync(file, list.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
              cleanup = file;
              args = ["-y", "-f", "concat", "-safe", "0", "-i", file, "-c", "copy", out];
              break;
            }
            case "compress":
              args = ["-y", "-i", src, ...(a.width ? ["-vf", `scale=${a.width}:-2`] : []), "-c:v", "libx264", "-crf", "28", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out];
              break;
            case "convert":
              args = extname(out).toLowerCase() === ".gif" ? ["-y", "-i", src, "-vf", `fps=12,scale=${a.width ?? 640}:-1:flags=lanczos`, out] : ["-y", "-i", src, ...scale, out];
              break;
            case "frame":
              args = ["-y", ...(a.at ? ["-ss", a.at] : []), "-i", src, "-frames:v", "1", ...scale, out];
              break;
            case "audio":
              args = ["-y", "-i", src, "-vn", out];
              break;
          }
          try {
            const r = await runFfmpeg(exe, args, 60 * 60_000, o.abortSignal);
            if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg could not do it:\n${tail(r.log)}`);
            return `Saved ${a.output} (${kb(out)}).`;
          } finally {
            if (cleanup) rmSync(cleanup, { force: true });
          }
        }),
    }),
  };
}
