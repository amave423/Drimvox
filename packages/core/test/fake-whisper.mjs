// whisper-cli for tests: checks it was given a model and a WAV, and prints what was "said".
const args = process.argv.slice(2);
const model = args[args.indexOf("-m") + 1];
const file = args[args.indexOf("-f") + 1];
if (!model || !file) {
  console.error("usage: -m model -f file");
  process.exit(1);
}
// The language it was told, so a test sees it was not left to guess.
const language = args.includes("-l") ? args[args.indexOf("-l") + 1] : "auto";
console.log(language === "ru" ? " Привет из whisper." : ` [${language}] Привет из whisper.`);
