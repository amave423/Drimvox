import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/agent/workspace";
import { desktopTools } from "../src/tools/desktop";

// docs/specs/tools.md: desktop apps in C# and Java, driven through Windows UI Automation.
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { toolCallId: name, messages: [] });
const dirs: string[] = [];
afterEach(() => {
  // Windows left open by a failed run.
  if (process.platform === "win32") spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Process powershell | Where-Object { $_.MainWindowTitle -in 'Запись в клинику', 'Чужое окно' } | Stop-Process"]);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// A small WPF window, as a desktop app built in a project would be.
const FORM = `﻿Add-Type -AssemblyName PresentationFramework
[xml]$x = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="Запись в клинику" Width="420" Height="240">
  <StackPanel Margin="16">
    <TextBox Name="patient" AutomationProperties.Name="Пациент" />
    <CheckBox Name="first" Content="Первичный приём" />
    <Button Name="go" Content="Записать" />
    <TextBlock Name="result" Text="Пусто" />
  </StackPanel>
</Window>
'@
$w = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $x))
$w.FindName('go').Add_Click({ $w.FindName('result').Text = "Записан: " + $w.FindName('patient').Text + $(if ($w.FindName('first').IsChecked) { ' (первичный)' } else { '' }) })
[void]$w.ShowDialog()
`;

describe.skipIf(process.platform !== "win32")("desktop apps", () => {
  it("starts a program, reads its window, types, clicks, takes a picture and closes it; asks before touching others' windows", async () => {
    const folder = mkdtempSync(join(tmpdir(), "drimvox-desktop-"));
    dirs.push(folder);
    writeFileSync(join(folder, "app.ps1"), FORM);
    const asked: string[] = [];
    const tools = desktopTools(folder, new Workspace(folder), { onCall: () => {}, askApproval: async (what) => (asked.push(what), false) });

    const started = await call(tools, "app_launch", { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "app.ps1"], wait: 60 });
    expect(started).toMatch(/Started \(process \d+\)\. Its windows:\n- "Запись в клинику" \(hwnd \d+/);
    expect(await call(tools, "app_windows", {})).toMatch(/"Запись в клинику" — hwnd \d+, powershell \(started by you\)/);

    const read = await call(tools, "app_read", { window: "клиник" });
    expect(read).toMatch(/^"Запись в клинику" \(hwnd \d+\), \d+ elements:/);
    const number = (pattern: RegExp) => Number(read.split("\n").find((l) => pattern.test(l))!.match(/\[(\d+)\]/)![1]);
    const field = number(/\] Edit "Пациент"/);
    const check = number(/\] CheckBox "Первичный приём"/);
    const button = number(/\] Button "Записать"/);

    expect(await call(tools, "app_type", { window: "клиник", element: field, text: "Иванова А. (+7)" })).toBe("Done: set the value.");
    expect(await call(tools, "app_click", { window: "клиник", element: check })).toMatch(/^Done: toggled: On\./);
    expect(await call(tools, "app_click", { window: "клиник", element: button })).toMatch(/^Done: invoked\./);
    const after = await call(tools, "app_read", { window: "клиник" });
    expect(after).toContain('Text "Записан: Иванова А. (+7) (первичный)"');
    expect(after).toContain('Edit "Пациент" #patient = "Иванова А. (+7)"');

    // A number from an old read that now points elsewhere is refused rather than clicking the wrong thing.
    await call(tools, "app_read", { window: "клиник" });
    expect(await call(tools, "app_click", { window: "клиник", element: 9999 })).toMatch(/No element 9999/);

    expect(await call(tools, "app_screenshot", { window: "клиник", path: "shots/form.png" })).toMatch(/^Saved "Запись в клинику" as shots\/form\.png \(\d+×\d+\)\.$/);
    const png = PNG.sync.read(readFileSync(join(folder, "shots/form.png")));
    expect(png.width).toBeGreaterThan(300);

    expect(await call(tools, "app_close", { window: "клиник" })).toBe('Done: closed "Запись в клинику".');
    expect(asked).toEqual([]);

    // A window of a program the agent did not start: closing it is asked about first, and here refused.
    writeFileSync(join(folder, "other.ps1"), FORM.replace('Title="Запись в клинику"', 'Title="Чужое окно"'));
    const stranger = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(folder, "other.ps1")], { stdio: "ignore" });
    try {
      for (let i = 0; i < 60 && !(await call(tools, "app_windows", {})).includes("Чужое окно"); i++) await new Promise((r) => setTimeout(r, 500));
      expect(await call(tools, "app_windows", {})).toMatch(/"Чужое окно" — hwnd \d+, powershell$/m);
      expect(await call(tools, "app_close", { window: "Чужое окно" })).toMatch(/did not allow/);
      expect(asked).toEqual(['Close "Чужое окно"']);
      expect(await call(tools, "app_windows", {})).toContain("Чужое окно");
    } finally {
      stranger.kill();
    }
  }, 120_000);
});
