// piper for tests: checks it was given a voice and an output file, and "reads" the text from standard input into it.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const out = args[args.indexOf("--output_file") + 1];
if (!model || !out) {
  console.error("usage: --model voice.onnx --output_file out.wav");
  process.exit(1);
}
readFileSync(`${model}.json`);
const text = readFileSync(0, "utf8");
writeFileSync(out, Buffer.concat([Buffer.from("RIFF....WAVE"), Buffer.from(text, "utf8")]));
