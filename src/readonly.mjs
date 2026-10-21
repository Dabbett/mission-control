// Guard: the only GraphQL document this tool ever sends must be a single read-only query.
// No GraphQL library, so this is a small top-level scanner: it strips comments, then splits the
// document into definitions by the first `{` at brace depth 0 and classifies each by its head.

export function stripComments(doc) {
  return doc
    .split("\n")
    .map((line) => {
      const i = line.indexOf("#");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** Returns one entry per top-level definition: { kind: "query" | "fragment" | "other", head } */
export function definitions(doc) {
  const text = stripComments(doc);
  const out = [];
  let depth = 0;
  let head = "";
  for (const ch of text) {
    if (ch === "{") {
      if (depth === 0) {
        const h = head.trim();
        const word = h.split(/\s+/)[0] ?? "";
        let kind = "other";
        if (h === "" || word === "query") kind = "query";
        else if (word === "fragment") kind = "fragment";
        out.push({ kind, head: h });
        head = "";
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) throw new Error("GraphQL document has unbalanced braces");
    } else if (depth === 0) {
      head += ch;
    }
  }
  if (depth !== 0) throw new Error("GraphQL document has unbalanced braces");
  if (head.trim() !== "") throw new Error("GraphQL document has trailing text outside a definition");
  return out;
}

/** Throws unless the document holds exactly one operation and it is a query. Fragments are fine. */
export function assertReadOnly(doc) {
  const ops = definitions(doc).filter((d) => d.kind !== "fragment");
  if (ops.length !== 1) throw new Error(`GraphQL document must hold exactly one operation, found ${ops.length}`);
  if (ops[0].kind !== "query") throw new Error(`GraphQL operation is not a query: "${ops[0].head.slice(0, 40)}"`);
  return true;
}
