import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extract, TEXT_LIMIT } from "../src/chats/attachments";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

// A one-page PDF with the text "Hello PDF", the smallest that readers accept.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 41>>stream\nBT /F1 18 Tf 20 40 Td (Hello PDF) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

describe("what an attachment gives the model", () => {
  it("sends a picture as a picture", async () => {
    expect(await extract("shot.png", "image/png", PNG)).toEqual({ kind: "image", text: null });
  });

  it("reads text files, and cuts a long one with a note", async () => {
    expect(await extract("app.ts", "", Buffer.from("export const a = 1;\n"))).toEqual({ kind: "text", text: "export const a = 1;\n" });
    const long = await extract("big.txt", "text/plain", Buffer.from("x".repeat(TEXT_LIMIT + 50)));
    expect(long.text!.length).toBeLessThan(TEXT_LIMIT + 200);
    expect(long.text).toMatch(/cut by Drimvox: 50 more characters/);
  });

  it("reads the text of a PDF", async () => {
    const pdf = await extract("doc.pdf", "application/pdf", PDF);
    expect(pdf.kind).toBe("text");
    expect(pdf.text).toContain("Hello PDF");
  });

  it("lists a ZIP and reads the text files in it", async () => {
    const zip = Buffer.from(zipSync({ "src/a.js": strToU8("const a = 1;"), "img/logo.png": new Uint8Array(PNG), "README.md": strToU8("# Hi") }));
    const got = await extract("project.zip", "application/zip", zip);
    expect(got.kind).toBe("text");
    expect(got.text).toContain("img/logo.png");
    expect(got.text).toContain("=== src/a.js ===\nconst a = 1;");
    expect(got.text).toContain("=== README.md ===\n# Hi");
    expect(got.text).not.toContain("=== img/logo.png ===");
  });

  it("says what it cannot read", async () => {
    expect(await extract("tool.exe", "application/octet-stream", Buffer.from([0x4d, 0x5a, 0, 0, 0xff, 0xfe]))).toEqual({ kind: "none", text: null });
  });
});
