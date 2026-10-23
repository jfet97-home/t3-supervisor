import type {GuidanceActivity} from "../../src/guidance-contract.js";

const outcomes: Record<string, string> = {
  observe_only: "Activity observed", no_match: "No guidance matched", needs_context: "Clarification needed",
  not_supervised: "Supervision not needed", uncertain: "Delivery not confirmed", sent: "Message sent",
  visible: "Message visible in conversation", accepted: "Update accepted by T3", rejected: "Update rejected",
  not_deliverable: "Message could not be delivered", delivered_later_run: "Message delivered to a later run",
  check_in_delivered: "Check-in delivered", progress_updated: "Progress updated", supervision_stopped: "Supervision stopped",
};

export const activityTitle = (item: GuidanceActivity): string => outcomes[item.reason] ?? outcomes[item.state] ?? "Supervisor activity recorded";
