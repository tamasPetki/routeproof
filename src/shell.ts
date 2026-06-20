// Minimal POSIX-ish word splitter for the --server command string.
// Handles single and double quotes (and \" \\ inside double quotes) so commands
// like  npx -y some-server --flag "a b"  parse correctly. No variable or glob
// expansion — we deliberately don't want a shell's surprises here.

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let started = false; // distinguishes "" (a real empty token) from whitespace
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }

  if (quote) throw new Error(`Unbalanced ${quote} quote in server command: ${input}`);
  if (started) tokens.push(cur);
  return tokens;
}
