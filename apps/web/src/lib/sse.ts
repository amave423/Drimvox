/**
 * Incremental parser for `data:` lines of a server-sent event stream.
 * Chunks may split lines anywhere; complete events are returned as parsed JSON.
 */
export function createSseParser<T>() {
  let buffer = "";
  return (chunk: string): T[] => {
    buffer += chunk;
    const events: T[] = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) events.push(JSON.parse(data) as T);
    }
    return events;
  };
}

/** POSTs JSON and hands every event to `onEvent` until the stream ends or `signal` aborts. */
export function postStream<T>(url: string, token: string, body: unknown, onEvent: (event: T) => void, signal: AbortSignal) {
  return readStream<T>(
    url,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal },
    onEvent,
  );
}

/** Follows a GET event stream until it ends or `signal` aborts. */
export function getStream<T>(url: string, token: string, onEvent: (event: T) => void, signal: AbortSignal) {
  return readStream<T>(url, { headers: { Authorization: `Bearer ${token}` }, signal }, onEvent);
}

async function readStream<T>(url: string, init: RequestInit, onEvent: (event: T) => void): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) throw new Error(`Core answered ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parse = createSseParser<T>();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    for (const event of parse(value)) onEvent(event);
  }
}
