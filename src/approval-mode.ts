export const approvalModes = ["alwaysAsk", "approveForMe", "fullAccess"] as const;

export type ApprovalMode = (typeof approvalModes)[number];

export function toMuseApprovalMode(mode: ApprovalMode): "allowAll" | "onRequest" | "promptUnmatched" {
  switch (mode) {
    case "alwaysAsk":
      return "onRequest";
    case "approveForMe":
      return "promptUnmatched";
    case "fullAccess":
      return "allowAll";
  }
}
