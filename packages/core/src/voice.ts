import { generateText } from "ai";
import { languageModel } from "./providers/model";
import type { Connection } from "./providers/repo";

/**
 * A recording turned into text by a model that hears (asked for: dictate a message): the voice model chosen in the
 * settings gets the audio and an instruction to write down exactly what was said.
 */
export async function transcribe(conn: Connection, model: string, audio: Buffer, mimeType: string): Promise<string> {
  const result = await generateText({
    model: languageModel(conn, model),
    maxRetries: 1,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Write down exactly what is said in this recording, in the language it is spoken, with punctuation. Answer with the text only: no quotes, no comments. If nothing is said, answer with nothing.",
          },
          { type: "file", data: audio, mediaType: mimeType },
        ],
      },
    ],
  });
  return result.text.trim();
}
