import { describe, expect, it } from "vitest";
import { describeCall } from "../src/chats/folder";

// Seen live: a call whose arguments came cut off showed its raw JSON (the file's whole content) as the file's name.
describe("what a call names in the feed", () => {
  it("is the path of arguments that came as text, readable or cut off", () => {
    expect(describeCall('{"path": "chart.js", "old": "a", "new": "b"}')).toBe("chart.js");
    expect(describeCall('{"path": "icons.js", "content": "// Иконки\n(function (global) {')).toBe("icons.js");
  });

  it("is nothing rather than the JSON when they name no file", () => {
    expect(describeCall('{"content": "// Линейные SVG-иконки\n(function () {')).toBe("");
    expect(describeCall('{"new": ".hourly-item:last-child { border-right: none; }')).toBe("");
  });

  it("keeps plain text as it is", () => {
    expect(describeCall("npm test")).toBe("npm test");
    expect(describeCall({ path: "app.js" })).toBe("app.js");
  });
});
