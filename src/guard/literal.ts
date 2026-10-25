import { err, ok, type Result } from "@/lib/result";

/**
 * Strict parser for plain data literals written by local models, e.g. a Python-style list
 * `[{'name': 'Mug', 'itemCost': 25.0, 'ok': True}]`. It accepts JSON plus single-quoted strings,
 * True/False/None and trailing commas, and nothing else: no identifiers, calls, tuples, sets,
 * operators or expressions. It never evaluates code. Size, depth and node counts are bounded.
 */

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

export const LITERAL_LIMITS = { maxLength: 20_000, maxDepth: 6, maxNodes: 500 } as const;

const KEYWORDS: Record<string, Literal> = { True: true, False: false, None: null, true: true, false: false, null: null };
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t", r: "\r", "/": "/", b: "\b", f: "\f" };

class LiteralError extends Error {}

class Parser {
  private pos = 0;
  private nodes = 0;
  constructor(private readonly src: string) {}

  parseAll(): Literal {
    const v = this.value(0);
    this.ws();
    if (this.pos !== this.src.length) this.fail("unexpected trailing characters");
    return v;
  }

  private fail(msg: string): never {
    throw new LiteralError(`${msg} at position ${this.pos}`);
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  private value(depth: number): Literal {
    if (depth > LITERAL_LIMITS.maxDepth) this.fail("nesting too deep");
    if (++this.nodes > LITERAL_LIMITS.maxNodes) this.fail("too many values");
    this.ws();
    const c = this.src[this.pos];
    if (c === "[") return this.list(depth);
    if (c === "{") return this.dict(depth);
    if (c === "'" || c === '"') return this.str();
    const num = NUMBER.exec(this.src.slice(this.pos));
    if (num) {
      this.pos += num[0].length;
      const n = Number(num[0]);
      if (!Number.isFinite(n)) this.fail("number out of range");
      return n;
    }
    const word = /^[A-Za-z_]\w*/.exec(this.src.slice(this.pos))?.[0];
    if (word !== undefined && Object.prototype.hasOwnProperty.call(KEYWORDS, word)) {
      this.pos += word.length;
      return KEYWORDS[word]!;
    }
    return this.fail("unsupported token");
  }

  private list(depth: number): Literal[] {
    this.pos++;
    const out: Literal[] = [];
    for (;;) {
      this.ws();
      if (this.src[this.pos] === "]") { this.pos++; return out; }
      out.push(this.value(depth + 1));
      this.ws();
      if (this.src[this.pos] === ",") { this.pos++; continue; }
      if (this.src[this.pos] === "]") { this.pos++; return out; }
      this.fail("expected , or ]");
    }
  }

  private dict(depth: number): { [key: string]: Literal } {
    this.pos++;
    const out: { [key: string]: Literal } = Object.create(null) as { [key: string]: Literal };
    for (;;) {
      this.ws();
      if (this.src[this.pos] === "}") { this.pos++; return { ...out }; }
      const q = this.src[this.pos];
      if (q !== "'" && q !== '"') this.fail("keys must be quoted strings");
      const key = this.str();
      if (key === "__proto__" || key === "constructor" || key === "prototype") this.fail("forbidden key");
      this.ws();
      if (this.src[this.pos] !== ":") this.fail("expected :");
      this.pos++;
      out[key] = this.value(depth + 1);
      this.ws();
      if (this.src[this.pos] === ",") { this.pos++; continue; }
      if (this.src[this.pos] === "}") { this.pos++; return { ...out }; }
      this.fail("expected , or }");
    }
  }

  private str(): string {
    const quote = this.src[this.pos++];
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++]!;
      if (c === quote) return out;
      if (c === "\n") this.fail("newline in string");
      if (c !== "\\") { out += c; continue; }
      const e = this.src[this.pos++];
      if (e === undefined) break;
      if (e === "u") {
        const hex = this.src.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("bad \\u escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 4;
        continue;
      }
      const mapped = ESCAPES[e];
      if (mapped === undefined) this.fail("unsupported escape");
      out += mapped;
    }
    return this.fail("unterminated string");
  }
}

/** Parses a plain data literal (JSON or Python-style). Never evaluates anything. */
export function parseLiteral(src: string): Result<Literal, string> {
  if (src.length > LITERAL_LIMITS.maxLength) return err("literal too long");
  try {
    return ok(new Parser(src.trim()).parseAll());
  } catch (e) {
    if (e instanceof LiteralError) return err(e.message);
    throw e;
  }
}
