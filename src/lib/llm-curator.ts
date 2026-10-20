// Compatibility entry point for callers of the original Ollama curator.
export { curateOllama as curateArticles } from "./curator/ollama";
export type { CurationResult } from "./curator/types";
