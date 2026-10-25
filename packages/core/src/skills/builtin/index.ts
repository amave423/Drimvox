import { DOCX } from "./docx";
import { PDF } from "./pdf";
import { PPTX } from "./pptx";
import { XLSX } from "./xlsx";

/** Drimvox's own ready skills, by id: SKILL.md of each. */
export const BUILTIN = { docx: DOCX, xlsx: XLSX, pptx: PPTX, pdf: PDF } as const;
