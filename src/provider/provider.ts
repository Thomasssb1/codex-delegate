export type ProviderRequest = {
  prompt: string;
  workspaceRoot: string;
};

export type ProviderResult = {
  response: string;
  stderr: string;
};

export interface Provider {
  run(request: ProviderRequest): Promise<ProviderResult>;
}
