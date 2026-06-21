// The AI emits formulas as LaTeX (e.g. "\lambda = \frac{1}{2}"), but the canvas draws text
// glyph-by-glyph and has no LaTeX engine. Without translation the raw control sequences are
// painted literally ("\lambda" instead of "λ"). This converts the common LaTeX subset the
// model produces into a plain Unicode string that the handwriting renderer can draw, while
// leaving ^/_ scripts intact so the renderer's existing superscript/subscript handling works.

// LaTeX control words mapped to a single Unicode glyph.
const SYMBOLS: Record<string, string> = {
  // Greek lowercase
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
  rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
  // Greek uppercase
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // Binary operators
  times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", ast: "∗", star: "⋆",
  oplus: "⊕", ominus: "⊖", otimes: "⊗", odot: "⊙", bullet: "•", circ: "∘",
  // Relations
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", equiv: "≡",
  approx: "≈", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  doteq: "≐", asymp: "≍",
  // Set theory & logic
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃",
  supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
  setminus: "∖", forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", top: "⊤", bot: "⊥",
  // Big operators
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
  // Arrows
  rightarrow: "→", to: "→", gets: "←", leftarrow: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", implies: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", iff: "⇔",
  mapsto: "↦", uparrow: "↑", downarrow: "↓", longrightarrow: "⟶", longleftarrow: "⟵",
  // Misc symbols
  infty: "∞", partial: "∂", nabla: "∇", angle: "∠", perp: "⊥", parallel: "∥",
  triangle: "△", prime: "′", deg: "°", degree: "°", hbar: "ℏ", ell: "ℓ",
  Re: "ℜ", Im: "ℑ", aleph: "ℵ", wp: "℘", surd: "√", checkmark: "✓",
  // Dots
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  // Delimiters
  langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
  // Spacing -> a single space (rendered as a small gap)
  quad: " ", qquad: "  ",
};

// \mathbb{X} blackboard-bold letters that have dedicated Unicode glyphs.
const BLACKBOARD: Record<string, string> = {
  R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", H: "ℍ", P: "ℙ", E: "𝔼",
};

// Commands that simply wrap content we want to keep verbatim (font/style switches).
const PASSTHROUGH = new Set([
  "text", "textrm", "textbf", "textit", "mathrm", "mathbf", "mathit",
  "mathsf", "mathtt", "mathcal", "mathscr", "boldsymbol", "operatorname",
]);

// Read a brace group starting at `open` (the index of "{"); returns the inner text and the
// index just past the closing "}". Falls back to end-of-string if unbalanced.
const readBraceGroup = (text: string, open: number): { value: string; end: number } => {
  let depth = 0;
  let value = "";
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      if (depth > 1) value += char;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { value, end: index + 1 };
      value += char;
      continue;
    }
    value += char;
  }
  return { value, end: text.length };
};

// Read the single "argument" after a command at index `start`: a brace group, a control
// sequence, or a single character. Used for \sqrt, ^, _, etc.
const readArgument = (text: string, start: number): { value: string; end: number } => {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return { value: "", end: index };
  if (text[index] === "{") return readBraceGroup(text, index);
  if (text[index] === "\\") {
    const match = /^\\([a-zA-Z]+|.)/.exec(text.slice(index));
    if (match) return { value: match[0], end: index + match[0].length };
  }
  return { value: text[index], end: index + 1 };
};

// Wrap a converted fraction part in parentheses when it is a multi-token expression, so
// "\frac{a+b}{c}" reads as "(a+b)/c" rather than the ambiguous "a+b/c".
const wrapPart = (part: string) =>
  /[\s+\-×÷/±∓]/.test(part.trim()) ? `(${part.trim()})` : part.trim();

export const latexToUnicode = (input: string): string => {
  let out = "";
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    // Drop math-mode delimiters.
    if (char === "$") {
      i += 1;
      continue;
    }

    // Normalize scripts to ^{...}/_{...} with converted contents so the renderer's
    // superscript/subscript pass receives Unicode rather than raw LaTeX.
    if (char === "^" || char === "_") {
      const arg = readArgument(input, i + 1);
      out += char + "{" + latexToUnicode(arg.value) + "}";
      i = arg.end;
      continue;
    }

    if (char !== "\\") {
      out += char;
      i += 1;
      continue;
    }

    // A control sequence: either a control word (\alpha) or a control symbol (\, \{ \%).
    const wordMatch = /^\\([a-zA-Z]+)/.exec(input.slice(i));
    if (!wordMatch) {
      const next = input[i + 1] ?? "";
      // Escaped literals and thin-space style commands.
      if ("{}%$&#_ ".includes(next)) {
        out += next === " " ? " " : next;
      }
      // "\," "\;" "\:" "\!" spacing -> small gap (or nothing for negative space).
      else if (",;:".includes(next)) out += " ";
      else if (next === "!") {
        /* negative thin space: emit nothing */
      } else out += next;
      i += 2;
      continue;
    }

    const command = wordMatch[1];
    let next = i + wordMatch[0].length;

    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      const num = readArgument(input, next);
      const den = readArgument(input, num.end);
      out += wrapPart(latexToUnicode(num.value)) + "/" + wrapPart(latexToUnicode(den.value));
      i = den.end;
      continue;
    }

    if (command === "sqrt") {
      // Optional [n] index, then the radicand.
      let cursor = next;
      while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
      if (input[cursor] === "[") {
        const close = input.indexOf("]", cursor);
        if (close !== -1) cursor = close + 1;
      }
      const rad = readArgument(input, cursor);
      out += "√" + wrapPart(latexToUnicode(rad.value));
      i = rad.end;
      continue;
    }

    if (command === "mathbb") {
      const arg = readArgument(input, next);
      const inner = arg.value.trim();
      out += BLACKBOARD[inner] ?? latexToUnicode(arg.value);
      i = arg.end;
      continue;
    }

    if (PASSTHROUGH.has(command)) {
      const arg = readArgument(input, next);
      out += latexToUnicode(arg.value);
      i = arg.end;
      continue;
    }

    // \left and \right: drop the command, keep the delimiter (\left( -> "(", \right. -> "").
    if (command === "left" || command === "right") {
      while (next < input.length && /\s/.test(input[next])) next += 1;
      const delim = input[next];
      if (delim === ".") {
        next += 1; // null delimiter, render nothing
      } else if (delim === "\\") {
        // e.g. \left\{ -> consume the escaped delimiter in the next loop iteration
      }
      i = next;
      continue;
    }

    if (command in SYMBOLS) {
      out += SYMBOLS[command];
      i = next;
      continue;
    }

    // Unknown command: drop the backslash, keep the name (e.g. \sin -> "sin", \log -> "log").
    out += command;
    i = next;
  }

  return out;
};
