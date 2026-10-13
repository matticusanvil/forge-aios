// Text helpers shared by the server and the browser.

/** "Bash: npm test", "Edit: app/page.tsx": one line for a tool call. */
export function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  return oneLine(toolTarget(input) ? `${name}: ${toolTarget(input)}` : name);
}

/** The part of a tool call worth showing: a command, a path, a pattern, a URL or a description. */
export function toolTarget(input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const detail = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt;
  return detail == null ? '' : redact(oneLine(String(detail)));
}

/** Markdown flattened to plain words, for one-line summaries: headings, emphasis, code ticks and links. */
export function plainText(text: string): string {
  return String(text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '');
}

export function oneLine(text: string, max = 200): string {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Best effort: hides token- and password-looking values before text is shown or leaves the machine. */
export function redact(text: string): string {
  return String(text)
    .replace(/(\/\/[^/\s:@]+:)[^@\s]+@/g, '$1***@')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b([\w-]*(?:token|secret|password|passwd|pwd|api[_-]?key|auth|credential)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[bpas]|tk|sb|eyJ)[\w-]*[_-][\w.-]{12,}|\beyJ[\w-]{10,}\.[\w.-]+/g, '***')
    .replace(/(?<![\w/.-])(?![0-9a-f]{8}-[0-9a-f]{4}-)[A-Za-z0-9+_-]{32,}={0,2}/g, '***'); // long random-looking strings, not paths or uuids
}
