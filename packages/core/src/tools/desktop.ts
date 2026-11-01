import { tool, type ToolSet } from "ai";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolHooks } from "../agent/tools";
import type { Workspace } from "../agent/workspace";
import { UIA_SCRIPT } from "./desktop-uia";

interface Owner {
  hwnd: number;
  pid: number;
  chain: number[];
}
interface Element {
  type: string;
  name: string;
  id: string;
  value: string | null;
  enabled: boolean;
  box: [number, number, number, number] | null;
  depth: number;
}

/** Programs the agent started, by process id: their windows it may click and type in without asking. */
const launched = new Set<number>();
/** What each window's elements were at the last app_read, to notice a window that changed before a click. */
const lastRead = new Map<string, Element[]>();

function script(): string {
  const file = join(tmpdir(), `drimvox-uia-${createHash("sha256").update(UIA_SCRIPT).digest("hex").slice(0, 12)}.ps1`);
  // With a BOM, so Windows PowerShell reads the script as UTF-8.
  if (!existsSync(file)) writeFileSync(file, `﻿${UIA_SCRIPT}`);
  return file;
}

/** One step of UI Automation, done by Windows PowerShell. */
export function uia<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return new Promise((done, fail) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script()],
      { env: { ...process.env, DRIMVOX_UIA: JSON.stringify(input) }, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", signal },
      (err, stdout, stderr) => {
        const line = stdout.trim().split(/\r?\n/).pop() ?? "";
        try {
          const out = JSON.parse(line) as T & { error?: string };
          if (out.error) return fail(new Error(out.error));
          done(out);
        } catch {
          fail(new Error((err?.message ?? stderr.trim()) || "UI Automation gave no answer."));
        }
      },
    ),
  );
}

const shown = (s: string | null | undefined, n = 60) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Desktop apps (docs/specs/tools.md, asked for with apps in C# and Java): the agent starts the program it built, sees
 * its windows and their elements through Windows UI Automation, clicks and types by element, and takes a picture of a
 * window. Windows only: macOS and Linux have their own accessibility layers, not wired yet.
 */
export function desktopTools(
  dataDir: string,
  ws: Workspace | null,
  hooks: Pick<ToolHooks, "onCall" | "askApproval">,
  see?: (png: Buffer, question: string, signal?: AbortSignal) => Promise<string>,
): ToolSet {
  if (process.platform !== "win32") return {};
  const run = async (name: string, input: string, work: () => Promise<string>) => {
    hooks.onCall({ callId: randomUUID(), name, input });
    try {
      return await work();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  /** Clicks, typing and closing in a window of a program the agent did not start need the user's yes. */
  async function acting<T extends { ask?: boolean; owner: Owner }>(what: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const first = await uia<T>({ ...input, allowed: [...launched] }, signal);
    if (!first.ask) return first;
    if ((await hooks.askApproval(what, "outside", signal)) === false) throw new Error("The user did not allow acting in this window: it belongs to a program the agent did not start.");
    return uia<T>({ ...input, any: true }, signal);
  }
  const expect = (window: string, n: number) => {
    const el = lastRead.get(window)?.[n];
    return el ? `${el.type} ${el.name}` : undefined;
  };
  const windowArg = z.string().min(1).describe("Part of the window's title, or its number (hwnd) from app_windows");
  const elementArg = z.number().int().min(0).describe("The element's number from the last app_read of this window");

  return {
    app_launch: tool({
      description:
        "Start a desktop program (such as the app built in the project: bin/Debug/net8.0-windows/App.exe, or `dotnet run`, `gradlew run`, java -jar app.jar) and wait for its window. Its windows can then be read, clicked and typed in. Windows only.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The program: a path in the folder, or a command such as dotnet, java, gradlew.bat"),
        args: z.array(z.string()).max(30).optional(),
        wait: z.number().int().min(1).max(180).optional().describe("Seconds to wait for a window (default 30; building first takes longer)"),
      }),
      execute: ({ command, args, wait }, o: { abortSignal?: AbortSignal }) =>
        run("app_launch", [command, ...(args ?? [])].join(" "), async () => {
          // A path in the folder (bin/Debug/App.exe, gradlew.bat), or a command found on PATH (dotnet, java).
          const local = ws && !isAbsolute(command) && (/[\\/]/.test(command) || existsSync(join(ws.root, command))) ? ws.resolve(command) : null;
          const inside = ws ? (p: string) => !relative(ws.root, p).startsWith("..") : () => false;
          const exe = local ?? (isAbsolute(command) ? resolve(command) : command);
          if (isAbsolute(exe) && !inside(exe) && (await hooks.askApproval([command, ...(args ?? [])].join(" "), "outside", o.abortSignal)) === false) throw new Error("The user did not allow starting it.");
          const child = spawn(exe, args ?? [], { cwd: ws?.root, detached: false, stdio: "ignore", windowsHide: false, shell: /\.(bat|cmd)$/i.test(exe) });
          const failed = new Promise<never>((_, fail) => child.once("error", (e) => fail(new Error(`Could not start it: ${e.message}`))));
          failed.catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
          if (!child.pid) await failed;
          const pid = child.pid!;
          child.unref();
          launched.add(pid);
          child.once("exit", () => launched.delete(pid));
          const deadline = Date.now() + (wait ?? 30) * 1000;
          while (Date.now() < deadline) {
            if (o.abortSignal?.aborted) throw new Error("Stopped.");
            const { windows } = await uia<{ windows: (Owner & { title: string; process: string })[] }>({ op: "windows" }, o.abortSignal);
            const mine = windows.filter((w) => w.chain.includes(pid));
            if (mine.length) {
              for (const w of mine) launched.add(w.pid);
              return `Started (process ${pid}). Its windows:\n${mine.map((w) => `- "${w.title}" (hwnd ${w.hwnd}, ${w.process})`).join("\n")}\nRead one with app_read.`;
            }
            if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`It exited with code ${child.exitCode} before showing a window.`);
            await new Promise((r) => setTimeout(r, 700));
          }
          return `Started (process ${pid}), but no window in ${wait ?? 30} s. It may still be building: call app_windows later.`;
        }),
    }),
    app_windows: tool({
      description: "The windows open on this computer: title, number (hwnd) and program; the ones of programs started with app_launch are marked.",
      inputSchema: z.object({}),
      execute: (_input, o: { abortSignal?: AbortSignal }) =>
        run("app_windows", "", async () => {
          const { windows } = await uia<{ windows: (Owner & { title: string; process: string })[] }>({ op: "windows" }, o.abortSignal);
          if (!windows.length) return "No windows.";
          return windows.map((w) => `- "${shown(w.title, 100)}" — hwnd ${w.hwnd}, ${w.process}${w.chain.some((id) => launched.has(id)) ? " (started by you)" : ""}`).join("\n");
        }),
    }),
    app_read: tool({
      description:
        "Read a window's elements through UI Automation: a numbered tree of buttons, fields, lists, menus, texts with their names, values and whether they are enabled. Use the numbers with app_click and app_type. Read again after the window changes.",
      inputSchema: z.object({ window: windowArg }),
      execute: ({ window }, o: { abortSignal?: AbortSignal }) =>
        run("app_read", window, async () => {
          const r = await uia<{ title: string; hwnd: number; elements: Element[]; cut: boolean }>({ op: "read", window }, o.abortSignal);
          const elements = r.elements ?? [];
          lastRead.set(window, elements);
          const lines = elements.map((e, i) => {
            const value = e.value && e.value !== e.name ? ` = "${shown(e.value)}"` : "";
            const id = e.id && e.id !== e.name ? ` #${shown(e.id, 40)}` : "";
            return `${"  ".repeat(Math.min(e.depth, 10))}[${i}] ${e.type}${e.name ? ` "${shown(e.name)}"` : ""}${id}${value}${e.enabled ? "" : " (disabled)"}`;
          });
          return `"${r.title}" (hwnd ${r.hwnd}), ${elements.length} elements${r.cut ? " (the first 500)" : ""}:\n${lines.join("\n")}`;
        }),
    }),
    app_click: tool({
      description: "Click an element of a window by its number from app_read: a button is pressed, a checkbox toggled, a list item or tab selected, a menu opened; otherwise the mouse clicks its middle.",
      inputSchema: z.object({ window: windowArg, element: elementArg }),
      execute: ({ window, element }, o: { abortSignal?: AbortSignal }) =>
        run("app_click", `${window} [${element}]`, async () => {
          const r = await acting<{ done: string; owner: Owner }>(`Click [${element}] in "${window}"`, { op: "click", window, n: element, expect: expect(window, element) }, o.abortSignal);
          return `Done: ${r.done}. Read the window again to see what changed.`;
        }),
    }),
    app_type: tool({
      description:
        "Type into an element by its number from app_read (a text field gets the text as its value), and/or press keys in SendKeys notation: {ENTER}, {TAB}, {ESC}, ^s for Ctrl+S, %{F4} for Alt+F4. Without an element, it goes to the window.",
      inputSchema: z.object({ window: windowArg, element: elementArg.optional(), text: z.string().max(10_000).optional(), keys: z.string().max(200).optional() }),
      execute: ({ window, element, text, keys }, o: { abortSignal?: AbortSignal }) =>
        run("app_type", `${window}${element === undefined ? "" : ` [${element}]`}`, async () => {
          if (text === undefined && !keys) throw new Error("Give text, keys or both.");
          const r = await acting<{ done: string; owner: Owner }>(`Type in "${window}"`, { op: "type", window, n: element ?? null, text: text ?? null, keys: keys ?? null, expect: element === undefined ? undefined : expect(window, element) }, o.abortSignal);
          return `Done: ${r.done || "focused"}.`;
        }),
    }),
    app_screenshot: tool({
      description: "A picture of a window (even behind others), saved in the folder when a path is given; with a question, a model that sees answers it about the picture.",
      inputSchema: z.object({ window: windowArg, path: z.string().optional().describe("Where to save the PNG, inside the folder"), question: z.string().max(500).optional() }),
      execute: ({ window, path, question }, o: { abortSignal?: AbortSignal }) =>
        run("app_screenshot", window, async () => {
          const target = path && ws ? ws.resolve(path) : join(dataDir, "desktop", `${Date.now()}.png`);
          mkdirSync(dirname(target), { recursive: true });
          const r = await uia<{ width: number; height: number; title: string }>({ op: "screenshot", window, path: target }, o.abortSignal);
          const where = path && ws ? path : target;
          const said = question && see ? await see(readFileSync(target), question, o.abortSignal).catch(() => "") : "";
          return `Saved "${r.title}" as ${where} (${r.width}×${r.height}).${said ? `\n${said}` : question ? "\nNo model that sees is set to answer the question." : ""}`;
        }),
    }),
    app_close: tool({
      description: "Close a window, as its × does.",
      inputSchema: z.object({ window: windowArg }),
      execute: ({ window }, o: { abortSignal?: AbortSignal }) =>
        run("app_close", window, async () => {
          const r = await acting<{ done: string; owner: Owner }>(`Close "${window}"`, { op: "close", window }, o.abortSignal);
          lastRead.delete(window);
          return `Done: ${r.done}.`;
        }),
    }),
  };
}
