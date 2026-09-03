export type ProviderRequest = {
  prompt: string;
  signal: AbortSignal;
  workspaceRoot: string;
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
