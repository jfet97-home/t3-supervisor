import { Icon } from "./icons.js";

type Tone = "on" | "off" | "unknown";
export function StatusBadge({label, tone = "unknown", icon = "shield"}: {label: string; tone?: Tone; icon?: "shield" | "pause" | "alert" | "activity"}) {
  return <span className={`scope-status scope-status-${tone}`}><Icon name={icon} size={18}/><span>{label}</span></span>;
}
export const globalStateLabel = (enabled: boolean | null) => enabled === null ? "Global supervision: Unknown" : enabled ? "Global supervision: On" : "Global supervision: Off";
export function GlobalSupervisionStatus({enabled}: {enabled: boolean | null}) {
  return <StatusBadge label={globalStateLabel(enabled)} tone={enabled === null ? "unknown" : enabled ? "on" : "off"} icon={enabled === false ? "pause" : enabled === null ? "alert" : "shield"}/>;
}
export function ProjectSupervisionStatus({enabled, effectiveEnabled, globallyEnabled, available = true}: {enabled: boolean; effectiveEnabled: boolean; globallyEnabled: boolean; available?: boolean}) {
  const label = !available ? "Project supervision: Status unavailable" : effectiveEnabled ? "Project supervision: On" : enabled && !globallyEnabled ? "Project supervision: Off — global supervision is off" : "Project supervision: Off";
  return <StatusBadge label={label} tone={!available ? "unknown" : effectiveEnabled ? "on" : "off"} icon={!available ? "alert" : effectiveEnabled ? "shield" : "pause"}/>;
}
