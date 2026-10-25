// whisper-cli for tests: checks it was given a model and a WAV, and prints what was "said".
const args = process.argv.slice(2);
const model = args[args.indexOf("-m") + 1];
const file = args[args.indexOf("-f") + 1];
if (!model || !file) {
  console.error("usage: -m model -f file");
  process.exit(1);
}
console.log(" Привет из whisper.");
