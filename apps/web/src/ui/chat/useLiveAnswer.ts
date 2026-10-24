import type { FollowEvent } from "@drimvox/shared";
import { useEffect, useRef, useState } from "react";
import { getStream } from "../../lib/sse";

export interface LiveAnswer {
  messageId: string;
  text: string;
  reasoning: string;
  activity: { name: string; input: string }[];
}

/**
 * Back in a chat whose answer is still being written (like ChatGPT and Claude): the answer goes on before the reader's
 * eyes, from what it has so far, letter by letter, instead of jumping once a second. `onEnd` runs when it is done.
 */
export function useLiveAnswer(chatId: string | null, active: boolean, token: string | null, onEnd: () => void): LiveAnswer | null {
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const ended = useRef(onEnd);
  ended.current = onEnd;

  useEffect(() => {
    setLive(null);
    if (!chatId || !active) return;
    const controller = new AbortController();
    const apply = (e: FollowEvent) => {
      if (e.type === "snapshot") setLive({ messageId: e.assistantMessageId, text: e.content, reasoning: e.reasoning, activity: e.activity });
      else if (e.type === "text") setLive((l) => l && { ...l, text: l.text + e.text });
      else if (e.type === "reasoning") setLive((l) => l && { ...l, reasoning: l.reasoning + e.text });
      else if (e.type === "tool") setLive((l) => l && { ...l, activity: [...l.activity, { name: e.name, input: e.input }] });
      // A request for permission or its answer: the chat loads it with the other open requests.
      else if (e.type === "approval" || e.type === "approved") ended.current();
    };
    void getStream<FollowEvent>(`/api/chats/${chatId}/follow`, token, apply, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) ended.current();
      });
    return () => controller.abort();
  }, [chatId, active, token]);

  return live;
}
