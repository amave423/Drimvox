import type { TaskStatus } from "@drimvox/shared";
import { useApp } from "../../context";
import type { MessageKey } from "../../i18n";

export function StatusDot({ status }: { status: TaskStatus }) {
  const { t } = useApp();
  return <span className={`status-dot is-${status}`} title={t(`task.status.${status}` as MessageKey)} aria-hidden />;
}

export function StatusChip({ status }: { status: TaskStatus }) {
  const { t } = useApp();
  return (
    <span className={`status-chip is-${status}`}>
      <span className={`status-dot is-${status}`} aria-hidden />
      {t(`task.status.${status}` as MessageKey)}
    </span>
  );
}
