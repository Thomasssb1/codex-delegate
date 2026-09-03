export type ProviderRequest = {
  requestInteraction?(interaction: InteractionRequest): Promise<InteractionResponse>;
  onActivity?(): void;
  prompt: string;
  signal: AbortSignal;
  workspaceRoot: string;
};

export type ApprovalRequest = {
  approvalId: string;
  choices: Array<{
    acceptsFeedback?: boolean;
    choiceId: string;
    decision: string;
    label: string;
  }>;
  kind: "approval";
  requirementId: {
    approvalId: string;
    sourceIndex: number;
  };
  toolName: string;
  turnId: string;
};

export type UserInputRequest = {
  kind: "userInput";
  questions: Array<{
    header: string;
    id: string;
    options: Array<{
      description?: string;
      label: string;
    }>;
    question: string;
    selection: {
      maxSelections?: number;
      minSelections?: number;
      mode: "multiple" | "single";
    };
  }>;
  toolName: string;
  turnId: string;
  userInputId: string;
};

export type InteractionRequest = ApprovalRequest | UserInputRequest;

export type InteractionResponse =
  | {
      choiceId: string;
      feedback?: string;
      kind: "approval";
    }
  | {
      answers: Array<{
        freeText?: string;
        note?: string;
        questionId: string;
        selectedLabel?: string;
        selectedLabels?: string[];
      }>;
      kind: "userInput";
    };

export type ProviderResult = {
  response: string;
  stderr: string;
};

export class ProviderRunError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderRunError";
  }
}

export interface Provider {
  run(request: ProviderRequest): Promise<ProviderResult>;
}
