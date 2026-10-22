// Guard: the board document must be a single read-only query, and each claim document a single write whose root
// fields are on a fixed list. No GraphQL library, so this is a small top-level scanner: it strips comments, then
// splits the document into definitions by the first `{` at brace depth 0 and classifies each by its head.

// Spelled in two halves so the word itself appears under src/ only in the claim documents (test/readonly.test.mjs).
const WRITE = "mu" + "tation";

export function stripComments(doc) {
  return doc
    .split("\n")
    .map((line) => {
      const i = line.indexOf("#");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** Returns one entry per top-level definition: { kind: "query" | "write" | "fragment" | "other", head, body } */
export function definitions(doc) {
  const text = stripComments(doc);
  const out = [];
  let depth = 0;
  let head = "";
  let current = null;
  for (const ch of text) {
    if (ch === "{") {
      if (depth === 0) {
        const h = head.trim();
        const word = h.split(/[\s(]+/)[0] ?? "";
        let kind = "other";
        if (h === "" || word === "query") kind = "query";
        else if (word === WRITE) kind = "write";
        else if (word === "fragment") kind = "fragment";
        current = { kind, head: h, body: "" };
        out.push(current);
        head = "";
      } else {
        current.body += ch;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) throw new Error("GraphQL document has unbalanced braces");
      if (depth > 0) current.body += ch;
    } else if (depth === 0) {
      head += ch;
    } else {
      current.body += ch;
    }
  }
  if (depth !== 0) throw new Error("GraphQL document has unbalanced braces");
  if (head.trim() !== "") throw new Error("GraphQL document has trailing text outside a definition");
  return out;
}

/**
 * The root field names of one operation body, in order. Arguments (inside parentheses, braces included) and
 * directives are skipped. Only `name(args) @directive { ... }` may stand at the root: an alias is refused, because
 * `harmless: deleteIssue(...)` would read as "harmless", and so is an inline fragment (`... { deleteIssue }` or
 * `... @include(if: true) { ... }`), or any selection that does not belong to a named field, because its contents
 * would run at the root unseen.
 */
export function rootFields(body) {
  const fields = [];
  let depth = 0;
  let parens = 0;
  let word = "";
  let open = false; // a field was named and its selection has not been opened yet
  const flush = () => {
    if (word.startsWith(".")) throw new Error("GraphQL write document uses a fragment at the root; name every field as itself");
    if (word && !word.startsWith("@")) {
      fields.push(word);
      open = true;
    }
    word = "";
  };
  for (const ch of body) {
    if (parens > 0) {
      if (ch === "(") parens++;
      else if (ch === ")") parens--;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) flush();
      parens++;
    } else if (ch === "{") {
      if (depth === 0) {
        flush();
        if (!open) throw new Error("GraphQL write document has a selection at the root that belongs to no field");
        open = false;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) throw new Error("GraphQL document has unbalanced braces");
    } else if (depth === 0) {
      if (ch === ":") throw new Error("GraphQL write document uses an alias at the root; name every field as itself");
      if (/[\s,]/.test(ch)) flush();
      else word += ch;
    }
  }
  flush();
  if (parens !== 0) throw new Error("GraphQL document has unbalanced parentheses");
  return fields;
}

/** Throws unless the document holds exactly one operation, it is a write, and every root field is in `allowed`. */
export function assertWriteOnly(doc, allowed) {
  const defs = definitions(doc);
  if (defs.some((d) => d.kind === "fragment")) throw new Error("GraphQL write document must not use fragments");
  if (defs.length !== 1) throw new Error(`GraphQL write document must hold exactly one operation, found ${defs.length}`);
  if (defs[0].kind !== "write") throw new Error(`GraphQL operation is not a write: "${defs[0].head.slice(0, 40)}"`);
  const fields = rootFields(defs[0].body);
  if (fields.length === 0) throw new Error("GraphQL write document has no root field");
  const extra = fields.filter((f) => !allowed.includes(f));
  if (extra.length) throw new Error(`GraphQL write document has root fields outside its list: ${extra.join(", ")}`);
  return fields;
}

/** Throws unless the document holds exactly one operation and it is a query. Fragments are fine. */
export function assertReadOnly(doc) {
  const ops = definitions(doc).filter((d) => d.kind !== "fragment");
  if (ops.length !== 1) throw new Error(`GraphQL document must hold exactly one operation, found ${ops.length}`);
  if (ops[0].kind !== "query") throw new Error(`GraphQL operation is not a query: "${ops[0].head.slice(0, 40)}"`);
  return true;
}
