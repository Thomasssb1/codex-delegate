export const approvalModes = ["alwaysAsk", "approveForMe", "denyUnmatched", "fullAccess"] as const;

export type ApprovalMode = (typeof approvalModes)[number];

export function toMuseApprovalMode(mode: ApprovalMode): "allowAll" | "denyUnmatched" | "onRequest" | "promptUnmatched" {
  switch (mode) {
    case "alwaysAsk":
      return "onRequest";
    case "approveForMe":
      return "promptUnmatched";
    case "denyUnmatched":
      return "denyUnmatched";
    case "fullAccess":
      return "allowAll";
  }
}
