// piper for tests: checks it was given a voice and an output file, and "reads" the text from standard input into it.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const out = args[args.indexOf("--output_file") + 1];
if (!model || !out) {
  console.error("usage: --model voice.onnx --output_file out.wav");
  process.exit(1);
}
// The real one crashes on a full path with letters outside ASCII (a Windows user named in Cyrillic): only relative ones.
if (isAbsolute(model) || isAbsolute(out)) {
  console.error("paths must be relative to piper's folder");
  process.exit(1);
}
readFileSync(`${model}.json`);
const text = readFileSync(0, "utf8");
writeFileSync(out, Buffer.concat([Buffer.from("RIFF....WAVE"), Buffer.from(text, "utf8")]));
