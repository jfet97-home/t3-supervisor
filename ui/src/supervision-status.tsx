import { Icon } from "./icons.js";

type Tone = "on" | "off" | "unknown";
export function StatusBadge({label, tone = "unknown", icon = "shield", compact = false}: {label: string; tone?: Tone; icon?: "shield" | "pause" | "alert" | "activity"; compact?: boolean}) {
  return <span className={`scope-status scope-status-${tone}${compact ? " scope-status-compact" : ""}`}><Icon name={icon} size={18}/><span>{label}</span></span>;
}
export const globalStateLabel = (enabled: boolean | null) => enabled === null ? "Global supervision: Unknown" : enabled ? "Global supervision: On" : "Global supervision: Off";
export function GlobalSupervisionStatus({enabled, compact = false}: {enabled: boolean | null; compact?: boolean}) {
  return <StatusBadge compact={compact} label={globalStateLabel(enabled)} tone={enabled === null ? "unknown" : enabled ? "on" : "off"} icon={enabled === false ? "pause" : enabled === null ? "alert" : "shield"}/>;
}
export function ProjectSupervisionStatus({enabled, effectiveEnabled, globallyEnabled, available = true, compact = false}: {enabled: boolean; effectiveEnabled: boolean; globallyEnabled: boolean; available?: boolean; compact?: boolean}) {
  const label = !available ? "Project supervision: Status unavailable" : effectiveEnabled ? "Project supervision: On" : enabled && !globallyEnabled ? "Project supervision: Off — global supervision is off" : "Project supervision: Off";
  return <StatusBadge compact={compact} label={label} tone={!available ? "unknown" : effectiveEnabled ? "on" : "off"} icon={!available ? "alert" : effectiveEnabled ? "shield" : "pause"}/>;
}

export function ConnectionStatus({connected}: {connected: boolean | null}) {
  const text = connected === null ? "T3 connection unavailable" : connected ? "T3 connected" : "T3 disconnected";
  return <span title={text} className={`connection ${connected ? "connected" : "disconnected"}`}>{connected ? <span className="dot online" aria-hidden="true"/> : <Icon name="alert" size={14}/>}<span className="connection-text">{text}</span></span>;
}
