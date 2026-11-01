import { DOCX } from "./docx";
import { PDF } from "./pdf";
import { PPTX } from "./pptx";
import { XLSX } from "./xlsx";
import { ACCESSIBILITY, DOCKER, DOCS, EMAIL, FASTAPI, NEXTJS, SECURITY, SEO } from "./craft";
import { AVALONIA, DOTNET, INSTALLERS, JAVA } from "./desktop";

/** Drimvox's own ready skills, by id: SKILL.md of each. */
export const BUILTIN = {
  docx: DOCX,
  xlsx: XLSX,
  pptx: PPTX,
  pdf: PDF,
  "security-review": SECURITY,
  "seo-performance": SEO,
  accessibility: ACCESSIBILITY,
  nextjs: NEXTJS,
  fastapi: FASTAPI,
  docker: DOCKER,
  "project-docs": DOCS,
  "email-html": EMAIL,
  "dotnet-desktop": DOTNET,
  avalonia: AVALONIA,
  "java-desktop": JAVA,
  "desktop-installers": INSTALLERS,
} as const;
