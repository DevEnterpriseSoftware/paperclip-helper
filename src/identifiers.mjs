// Paperclip issue identifiers (ACM-12) in a pull request: how the relay and the
// watchdog tell which issues a PR is about. The first one named is the PR's own.

function identifierRegex(prefixes) {
  const alternatives = prefixes.map((p) => p.replace(/[^A-Z0-9]/gi, "")).filter(Boolean);
  // With no known prefix, fall back to Paperclip's identifier shape.
  const prefix = alternatives.length ? `(${alternatives.join("|")})` : "([A-Z][A-Z0-9]*)";
  return new RegExp(`\\b${prefix}-(\\d+)\\b`, "gi");
}

// The identifier that starts the PR's title ("ACM-12: …", "[ACM-12] …"), or null.
// One named later in the title is a mention, not the PR's own issue.
export function titleIdentifier(pr, prefixes) {
  const title = typeof pr?.title === "string" ? pr.title : "";
  const match = new RegExp(`^[\\s\\[(]*${identifierRegex(prefixes).source}`, "i").exec(title);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

// Every issue identifier the PR names, in order: title, branch, body.
export function findIdentifiers(pr, prefixes) {
  const found = [];
  const pattern = identifierRegex(prefixes);
  for (const text of [pr?.title, pr?.head?.ref, pr?.body]) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(pattern)) {
      const id = `${match[1].toUpperCase()}-${match[2]}`;
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}

