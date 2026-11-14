/**
 * Commands that publish the work: a release, a package, a deploy to a server. While Drimvox's tester has not yet tried
 * the turn's work, they wait (seen live: the rule "publish nothing before a clean check" was in the agent's instructions,
 * and it released Nexus 0.7.0 in the same answer anyway; asked for: rules kept by Drimvox, not left to the model).
 */
export const PUBLISHES =
  /\bgh\s+release\s+(create|upload|edit)\b|\bnpm\s+publish\b|\bdocker\s+push\b|\b(vercel|netlify)\b[^\n]*\bdeploy\b|\bgit\s+push\b[^\n;|&]*(--tags\b|refs\/tags\/)|\bsystemctl\s+(restart|reload|start)\b|\bpm2\s+(restart|reload|start)\b|^ssh_upload\b/i;

/** What the agent is told instead of running it. */
export const HELD =
  "Not yet: Drimvox's tester tries this turn's work before anything is published. Finish the work and reply that it is ready; after a clean check you are told to publish.";

/** After a turn that changed no files: nothing to check, the release or deploy that waited goes out now. */
export const NOTHING_TO_CHECK =
  "[Drimvox: this turn changed no files, so there is nothing for the tester to try.] If the user asked to publish (a release, a deploy, an upload), do it now. Otherwise reply in one line that it is done.";
