// Answer extraction, normalization and equivalence checking for MATH-style LaTeX answers.

/** Returns the content of the last \boxed{...} (or \fbox{...}) in a solution, or null. */
export function extractBoxed(solution) {
  const re = /\\(?:boxed|fbox)\s*\{/g;
  let last = null;
  let m;
  while ((m = re.exec(solution))) last = m.index + m[0].length;
  if (last === null) {
    const s = solution.match(/\\boxed ([^\s$]+)/g);
    return s ? s[s.length - 1].slice(7) : null;
  }
  let depth = 1;
  for (let i = last; i < solution.length; i++) {
    if (solution[i] === "{") depth++;
    else if (solution[i] === "}" && --depth === 0) return solution.slice(last, i).trim();
  }
  return null;
}

function stripCommand(s, cmd) {
  // Replace \cmd{X} with X, handling nested braces.
  const needle = `\\${cmd}{`;
  let idx;
  while ((idx = s.indexOf(needle)) !== -1) {
    let depth = 1, j = idx + needle.length;
    for (; j < s.length && depth; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
    }
    s = s.slice(0, idx) + s.slice(idx + needle.length, j - 1) + s.slice(j);
  }
  return s;
}

/** Canonical string form of an answer (LaTeX or plain typed input). */
export function normalize(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  s = s.replace(/^\$+|\$+$/g, "");
  s = s.replace(/\\(?:left|right)\b/g, "");
  s = s.replace(/\\[dt]frac/g, "\\frac");
  s = s.replace(/\^\s*\{?\\circ\}?|°|\\degree/g, "");
  s = s.replace(/\\%|%/g, "");
  s = s.replace(/\\\$/g, "");
  s = s.replace(/\\(?:,|;|!|:|quad|qquad)/g, "");
  s = s.replace(/~/g, "");
  // Drop unit text such as "5\text{ cm}" but keep text-only answers like "\text{(C)}".
  const noText = s.replace(/\\(?:text|textbf|mbox|mathrm)\{[^{}]*\}/g, "").trim();
  if (noText && /[0-9]/.test(noText)) s = noText;
  for (const c of ["text", "textbf", "mbox", "mathrm", "mathbf"]) s = stripCommand(s, c);
  s = s.replace(/^[a-zA-Z]\s*=\s*/, "");
  s = s.replace(/\s+/g, "");
  s = s.replace(/\.$/, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  s = s.replace(/^\((.*)\)$/, (m, inner) => (inner.includes(",") ? m : inner));
  return s.toLowerCase();
}

/** Converts a normalized answer to a JS-evaluable expression, or null if unsupported. */
function toJsExpr(s) {
  let e = s;
  // \frac12 -> \frac{1}{2}
  e = e.replace(/\\frac(\d)(\d)/g, "\\frac{$1}{$2}");
  e = e.replace(/\\sqrt(\d+)/g, "\\sqrt{$1}");
  for (let i = 0; i < 10 && /\\(frac|sqrt)\{/.test(e); i++) {
    e = e.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "(($1)/($2))");
    e = e.replace(/\\sqrt\[([^\]]*)\]\{([^{}]*)\}/g, "(($2)**(1/($1)))");
    e = e.replace(/\\sqrt\{([^{}]*)\}/g, "Math.sqrt($1)");
  }
  e = e.replace(/\\pi|π|pi/g, "(Math.PI)").replace(/\\cdot|\\times/g, "*");
  e = e.replace(/sqrt\(/g, "Math.sqrt(").replace(/Math\.Math\./g, "Math.");
  e = e.replace(/\^\{([^{}]*)\}/g, "**($1)").replace(/\^/g, "**");
  e = e.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
  if (/\\/.test(e)) return null;
  // Implicit multiplication: 2(…), 2Math.sqrt, )(, )2
  e = e.replace(/(\d|\))\s*(?=\(|Math)/g, "$1*").replace(/\)(?=\d)/g, ")*");
  const check = e.replace(/Math\.(sqrt|PI)/g, "");
  if (!/^[0-9.+\-*/()\s]*$/.test(check) || !/\d/.test(check)) return null;
  return e;
}

/** Numeric value of an answer, or null when it is not a closed-form number. */
export function numericValue(raw) {
  const s = normalize(raw);
  if (s === "") return null;
  const expr = toJsExpr(s);
  if (!expr) return null;
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** True when the learner's answer matches the expected answer. */
export function isEquivalent(given, expected) {
  const a = normalize(given), b = normalize(expected);
  if (!a) return false;
  if (a === b) return true;
  const va = numericValue(given), vb = numericValue(expected);
  if (va !== null && vb !== null) return Math.abs(va - vb) <= 1e-6 * Math.max(1, Math.abs(vb));
  return false;
}

export function answerKind(answer) {
  return numericValue(answer) !== null ? "numeric" : "expression";
}
