// JARVIS Skill: Calculator
// Uses a safe recursive-descent parser — no eval(), no new Function().
// Only handles: numbers, +, -, *, /, %, (, ), unary minus.

const args = JSON.parse(process.argv[2] || '{"expression":""}');
const rawExpr = (args.expression || '').toString();

/**
 * Tiny, safe expression parser.
 * Grammar (EBNF):
 *   expr   = term   { ('+' | '-') term   }
 *   term   = unary  { ('*' | '/' | '%') unary }
 *   unary  = '-' unary | primary
 *   primary= number | '(' expr ')'
 *   number = /[0-9]+(\.[0-9]+)?/
 */
function safeParse(src) {
  const s = src.replace(/\s+/g, ''); // strip whitespace
  let pos = 0;

  function peek() { return s[pos]; }
  function consume(ch) { if (s[pos] !== ch) throw new Error(`Expected '${ch}' at pos ${pos}`); pos++; }

  function parseExpr() {
    let left = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[pos++];
      const right = parseUnary();
      if (op === '/' && right === 0) throw new Error('Division by zero');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }

  function parseUnary() {
    if (peek() === '-') { pos++; return -parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    if (peek() === '(') {
      pos++;
      const v = parseExpr();
      consume(')');
      return v;
    }
    const start = pos;
    while (pos < s.length && /[0-9.]/.test(s[pos])) pos++;
    if (pos === start) throw new Error(`Unexpected char '${s[pos]}' at pos ${pos}`);
    return parseFloat(s.slice(start, pos));
  }

  const result = parseExpr();
  if (pos !== s.length) throw new Error(`Unexpected token '${s[pos]}' at pos ${pos}`);
  return result;
}

function safeEval(expression) {
  const cleaned = expression.replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**').trim();
  if (!cleaned) return { error: 'Empty expression' };
  // Extra guard: reject anything outside the whitelist before parsing
  if (/[^0-9+\-*/%.() ]/.test(cleaned)) return { error: 'Invalid characters in expression' };
  try {
    const result = safeParse(cleaned);
    if (!isFinite(result)) return { error: 'Result is not finite (division by zero?)' };
    return { result, expression: cleaned };
  } catch (e) {
    return { error: e.message };
  }
}

const calc = safeEval(rawExpr);
console.log(JSON.stringify({ ok: !calc.error, skill: 'calculator', data: calc }));

