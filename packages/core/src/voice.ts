import { generateText } from "ai";
import { languageModel } from "./providers/model";
import type { Connection } from "./providers/repo";
import { thinkingOptions } from "./chats/thinking";

/**
 * A recording turned into text by a model that hears (asked for: dictate a message): the voice model chosen in the
 * settings gets the audio and an instruction to write down exactly what was said.
 */
const LANGUAGES: Record<string, string> = { ru: "Russian", en: "English" };

export async function transcribe(conn: Connection, model: string, audio: Buffer, mimeType: string, language = "auto"): Promise<string> {
  const spoken = LANGUAGES[language] ? `It is spoken in ${LANGUAGES[language]}: write it in ${LANGUAGES[language]}, never translated.` : "Write it in the language it is spoken in, never translated.";
  const result = await generateText({
    model: languageModel(conn, model),
    // A model that thinks first may put the words in its thinking and answer with nothing (seen: every dictation failed
    // with a free "reasoning" model); writing down needs no thinking.
    providerOptions: thinkingOptions(conn.preset, "off"),
    // Free models are often busy for a moment.
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(120_000),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Write down exactly what is said in this recording, with punctuation. ${spoken} Answer with the text only: no quotes, no comments. If nothing is said, answer with nothing.`,
          },
          { type: "file", data: audio, mediaType: mimeType },
        ],
      },
    ],
  });
  return result.text.trim();
}
