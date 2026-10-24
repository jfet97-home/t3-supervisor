import {Icon} from "./icons.js";

export function RefreshAction({label, busy, enabled, onRefresh}: {label: string; busy: boolean; enabled: boolean; onRefresh: () => void}) {
  return <button type="button" className="quiet-button icon-action" aria-label={label} title={busy ? `${label} — refreshing` : label} aria-disabled={!enabled || busy} onClick={() => {if (enabled && !busy) onRefresh();}}><Icon name="refresh" size={16}/></button>;
}
