export const redact = (value: string) => value.replace(/\b(?:Bearer\s+\S+|(?:sk-|ghp_|github_pat_|eyJ)[A-Za-z0-9_.-]{15,})/giu, "[redacted credential]")
  .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)(?:\[redacted credential\]|\[redacted\]|\S+)/giu, "$1[redacted]");
