import type { TaskEvent, TaskUpdate, TaskView } from "@drimvox/shared";
import { useEffect, useState } from "react";
import { useApp } from "../../context";
import { getStream } from "../../lib/sse";

/** Live task state and event log; reconnects and resumes from the last event it saw. */
export function useTaskStream(taskId: string) {
  const { token, reloadTasks, reloadToday } = useApp();
  const [task, setTask] = useState<TaskView | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let lastSeq = 0;
    setTask(null);
    setEvents([]);

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await getStream<TaskUpdate>(
            `/api/tasks/${taskId}/stream?after=${lastSeq}`,
            token,
            (update) => {
              if (update.type === "task") setTask(update.task);
              else if (update.event.seq > lastSeq) {
                lastSeq = update.event.seq;
                setEvents((prev) => [...prev, update.event]);
              }
            },
            controller.signal,
          );
        } catch {
          // The core restarted or the network blinked; try again shortly.
        }
        if (!controller.signal.aborted) await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => controller.abort();
  }, [taskId, token]);

  // The sidebar and the day's spend follow the task's status changes.
  const status = task?.status;
  useEffect(() => {
    if (!status) return;
    void reloadTasks();
    void reloadToday();
  }, [status, reloadTasks, reloadToday]);

  return { task, events, setTask };
}
