import { mcpTrusts, type McpTrust } from "@drimvox/shared";
import { useId } from "react";
import { useApp } from "../context";
import type { MessageKey } from "../i18n";
import { Segmented } from "./Segmented";

/**
 * How much an MCP server is trusted (asked for: a server one switched on should not keep asking): about everything,
 * only about what changes something, or about nothing — with what the chosen one means, as a warning where it matters.
 */
export function McpTrustChoice({ value, onChange, name }: { value: McpTrust; onChange(trust: McpTrust): void; name: string }) {
  const { t } = useApp();
  const id = useId();
  return (
    <div className="mcp-trust">
      <span className="field-label" id={id}>
        {t("mcp.trust")}
      </span>
      <Segmented value={value} labelledBy={id} options={mcpTrusts.map((v) => ({ value: v, label: t(`mcp.trust.${v}` as MessageKey) }))} onChange={onChange} />
      <p className={value === "trusted" ? "note is-pencil" : "muted"}>{t(`mcp.trust.${value}.about` as MessageKey, { name })}</p>
    </div>
  );
}
