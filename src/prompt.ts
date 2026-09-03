export function createPrompt(instructions: string, task: string): string {
  return `${instructions}\n\nTask:\n${task}\n\nWork only in the current checkout. Do not commit or modify .git.`;
}
