export const approvalModes = ["denyUnmatched", "fullAccess"] as const;

export type ApprovalMode = (typeof approvalModes)[number];

export function toMuseApprovalMode(mode: ApprovalMode): "allowAll" | "denyUnmatched" {
  switch (mode) {
    case "denyUnmatched":
      return "denyUnmatched";
    case "fullAccess":
      return "allowAll";
  }
}
