import { execFile } from "node:child_process";
import { extname } from "node:path";
import { askAboutPictures, type Vision } from "../visual/look";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };
const PROMPT =
  "Write out all the text on this image exactly as it is, line by line, keeping its language, numbers and layout " +
  "(tables as rows with | between cells). Write nothing else. If there is no text, answer: (no text)";

/**
 * Text on a picture or a scan (docs/specs/tools.md, asked for): a model that sees reads it best, any language and
 * handwriting; without one, Windows reads it itself (its own OCR, the languages installed in Windows).
 */
export async function readImageText(path: string, data: Buffer, vision: Vision | null, signal?: AbortSignal): Promise<{ text: string; by: string }> {
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error("Not a picture (png, jpg, webp, gif, bmp)");
  if (vision && type !== "image/bmp") {
    const answer = await askAboutPictures(vision, [{ data, mediaType: type }], PROMPT, signal);
    return { text: answer.text.trim(), by: vision.model };
  }
  if (process.platform !== "win32") throw new Error("No model that sees pictures is set: choose one in the settings (Models → the model that looks at pictures).");
  return { text: await windowsOcr(path, signal), by: "Windows OCR" };
}

/** Windows' own text recognition (Windows.Media.Ocr), through PowerShell; the user's languages as Windows has them. */
function windowsOcr(path: string, signal?: AbortSignal): Promise<string> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:DRIMVOX_OCR_FILE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'Windows has no text recognition language installed' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[Console]::OutputEncoding = [Text.Encoding]::UTF8
($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, DRIMVOX_OCR_FILE: path }, timeout: 60_000, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Windows could not read the picture: ${(stderr || err.message).trim().split("\n").at(-1)}`));
        resolve(stdout.trim() || "(no text)");
      },
    );
  });
}
