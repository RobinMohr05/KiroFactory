export interface KiroModelOption {
  id: string;
  name: string;
}

export const KIRO_MODELS: KiroModelOption[] = [
  { id: "auto", name: "Auto (default)" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  { id: "minimax-m2.5", name: "MiniMax M2.5" },
  { id: "minimax-m2.1", name: "MiniMax M2.1" },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
];
