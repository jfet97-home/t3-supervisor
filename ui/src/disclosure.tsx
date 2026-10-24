import type { ComponentProps, ReactNode } from "react";
import { Icon } from "./icons.js";

type Props = Omit<ComponentProps<"details">, "title"> & {title: ReactNode; icon?: ComponentProps<typeof Icon>["name"]; summaryProps?: ComponentProps<"summary">};
function Disclosure({title, icon = "record", className = "", children, kind, summaryProps, ...props}: Props & {kind: "help" | "entity"}) {
  return <details {...props} className={`disclosure disclosure-${kind} ${className}`}>
    <summary {...summaryProps}><Icon name={kind === "help" ? "info" : icon} size={18}/><span className="disclosure-title">{title}</span><span className="disclosure-cue" aria-hidden="true"><Icon name="plus" size={16}/><Icon name="minus" size={16}/></span></summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}
export const HelpDisclosure = (props: Props) => <Disclosure {...props} kind="help"/>;
export const EntityDetails = (props: Props) => <Disclosure {...props} kind="entity"/>;
