/** Retrieval only. A fuzzy match is never evidence of authorization or consent. */
export function normalizeConnectionSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const STOP_WORDS = new Set("a an and are as at be by can connect connection connections do find for from get help i in is it me my need not of on or our please real service services so some that the their them there this to tool tools use want we with would you your".split(" "));
const GENERIC_NAMES = new Set([...STOP_WORDS, "contacts", "email"]);

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function scoreConnectionSearch(query: string, names: readonly string[], description = "") {
  const normalized = normalizeConnectionSearch(query);
  if (!normalized) return { score: 1, nameScore: 0 };
  const words = normalized.split(" ");
  let nameScore = 0;
  for (const name of names) {
    const normalizedName = normalizeConnectionSearch(name);
    const compact = normalizedName.replaceAll(" ", "");
    if (!compact) continue;
    if (compact === normalized.replaceAll(" ", "")) {
      nameScore = Math.max(nameScore, 1000);
      continue;
    }
    if (normalizedName.split(" ").every(word => GENERIC_NAMES.has(word))) continue;
    // Compare short windows so "Agent Mail" and "Circle Back" match compact
    // product names without requiring every word of a task description to match.
    const windowSize = Math.min(6, normalizedName.split(" ").length + 2);
    for (let start = 0; start < words.length; start++) {
      let phrase = "";
      for (let size = 1; size <= windowSize && start + size <= words.length; size++) {
        phrase += words[start + size - 1];
        if (phrase === compact) nameScore = Math.max(nameScore, 500 + compact.length);
        else if (compact.length >= 5 && phrase.length >= 5 && oneEditApart(phrase, compact)) {
          nameScore = Math.max(nameScore, 200 + compact.length);
        } else if (words.length === size && phrase.length >= 4 && compact.startsWith(phrase)) {
          nameScore = Math.max(nameScore, 100 + phrase.length);
        }
      }
    }
  }
  const terms = [...new Set(words.filter(word => word.length > 1 && !STOP_WORDS.has(word)))];
  const haystack = new Set(normalizeConnectionSearch(description).split(" "));
  const matched = terms.filter(term => haystack.has(term)
    || (term.length >= 4 && [...haystack].some(word => word.startsWith(term) || (word.length >= 4 && term.startsWith(word)))));
  return { nameScore, score: nameScore + Math.min(80, matched.length * 5) };
}
