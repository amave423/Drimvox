import { Fragment } from "react";
import { useApp } from "../context";
import { useAddProject } from "./projects/AddProject";

/** Where a link in a text leads: a part of the app, a new chat, or adding a project. */
type Target = "providers" | "local" | "settings" | "chat" | "project" | "gallery";

/**
 * A text whose [names](target) open what they name (seen: the guide said «Ключи и модели», «+ Проект» and nothing
 * could be clicked).
 */
export function LinkedText({ text }: { text: string }) {
  const { navigate, openNewChat } = useApp();
  const project = useAddProject();
  const go = (target: Target) => {
    if (target === "chat") return openNewChat();
    if (target === "project") return void project.pick();
    navigate({ kind: target });
  };
  const parts = text.split(/\[([^\]]+)\]\((providers|local|settings|chat|project|gallery)\)/);
  return (
    <>
      {parts.map((part, n) =>
        n % 3 === 1 ? (
          <button key={n} type="button" className="link" onClick={() => go(parts[n + 1] as Target)}>
            {part}
          </button>
        ) : n % 3 === 2 ? null : (
          <Fragment key={n}>{part}</Fragment>
        ),
      )}
    </>
  );
}
