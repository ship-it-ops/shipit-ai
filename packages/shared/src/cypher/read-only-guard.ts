// The read-only check for Cypher that a caller wrote.
//
// Two surfaces run a query string someone else typed: the Query Playground
// (api-server, POST /api/query) and the graph_query MCP tool. Both pass the
// text through this one check, so neither can be the weaker door.
//
// It is one layer of two. The database refuses writes by itself: both surfaces
// run the query in a read-access transaction that is always rolled back
// (runReadOnlyQuery in @shipit-ai/mcp-server). This check stands in front of
// that, and also stops what a read transaction still permits: importing from a
// file or a URL, and calling into code that was installed on the server.
//
// How it decides:
//  - Cypher's own clauses are a closed set, fixed by the language. The ones
//    that write, administer or import are refused by name.
//  - Procedures and namespaced functions are an open set; every plugin adds
//    more. A list of the unwanted ones can never be complete, so the wanted
//    ones are listed and every other one is refused.
//  - The check reads text, so it has to split the text into the same tokens
//    the database will. Wherever it cannot be sure of that, it refuses.

export type ReadOnlyCypherRefusal =
  /** Nothing to run. */
  | 'EMPTY'
  /** Longer than any query needs to be. */
  | 'TOO_LONG'
  /** Text this check cannot be sure it reads the way the database will. */
  | 'UNREADABLE'
  /** A clause that writes, administers or imports. */
  | 'WRITE_KEYWORD'
  /** A CALL of anything but a subquery or a listed procedure. */
  | 'PROCEDURE'
  /** A namespaced function that is not listed. */
  | 'FUNCTION'
  /** A label that names the application's own bookkeeping. */
  | 'INTERNAL_LABEL';

export type ReadOnlyCypherVerdict =
  { ok: true } | { ok: false; code: ReadOnlyCypherRefusal; message: string; keyword?: string };

/**
 * Nodes whose label starts with an underscore are the application's own
 * bookkeeping (access tokens, linking keys, the idempotency log), not part of
 * the catalog.
 */
export function isInternalLabel(label: string): boolean {
  return label.startsWith('_');
}

// Every clause keyword that writes to the graph, changes the schema, runs an
// administration command, imports data, or moves the query to another graph or
// into transactions of its own. A word on this list is refused wherever it
// stands as a bare word; a name that collides with one has to be quoted in
// backticks. When Cypher gains a clause, review this list.
const WRITE_KEYWORDS: ReadonlySet<string> = new Set([
  // Graph writes.
  'CREATE',
  'INSERT',
  'MERGE',
  'SET',
  'REMOVE',
  'DELETE',
  'DETACH',
  'NODETACH',
  'FOREACH',
  // Import.
  'LOAD',
  // Schema and administration commands.
  'DROP',
  'ALTER',
  'RENAME',
  'GRANT',
  'DENY',
  'REVOKE',
  'START',
  'STOP',
  'ENABLE',
  'DEALLOCATE',
  'REALLOCATE',
  'DRYRUN',
  'TERMINATE',
  'SHOW',
  // Another graph, or transactions of the query's own (CALL { } IN TRANSACTIONS).
  'USE',
  'TRANSACTIONS',
]);

// The procedures a raw query may CALL, by exact name. Add one only if it reads
// the graph and nothing else: it takes no query text to run, touches no file
// and no network, and starts no work of its own.
const ALLOWED_PROCEDURES: ReadonlySet<string> = new Set([
  'db.labels',
  'db.relationshipTypes',
  'db.propertyKeys',
  'db.schema.visualization',
  'db.schema.nodeTypeProperties',
  'db.schema.relTypeProperties',
  'apoc.path.expand',
  'apoc.path.expandConfig',
  'apoc.path.spanningTree',
  'apoc.path.subgraphAll',
  'apoc.path.subgraphNodes',
]);

// The namespaced functions a raw query may use, lower-cased. Cypher's built-in
// functions without a namespace (toUpper, size, datetime, ...) need no entry:
// a plugin cannot add a function there. The same rule as above applies to
// additions. The three apoc.convert functions are here because claims are
// stored as JSON text (`_claims`) and cannot be read without them.
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'date.realtime',
  'date.statement',
  'date.transaction',
  'date.truncate',
  'datetime.fromepoch',
  'datetime.fromepochmillis',
  'datetime.realtime',
  'datetime.statement',
  'datetime.transaction',
  'datetime.truncate',
  'localdatetime.realtime',
  'localdatetime.statement',
  'localdatetime.transaction',
  'localdatetime.truncate',
  'localtime.realtime',
  'localtime.statement',
  'localtime.transaction',
  'localtime.truncate',
  'time.realtime',
  'time.statement',
  'time.transaction',
  'time.truncate',
  'duration.between',
  'duration.indays',
  'duration.inmonths',
  'duration.inseconds',
  'point.distance',
  'point.withinbbox',
  'vector.similarity.cosine',
  'vector.similarity.euclidean',
  'apoc.convert.fromjsonlist',
  'apoc.convert.fromjsonmap',
  'apoc.convert.tojson',
]);

// Long lists belong in parameters. The limit also bounds the work this check
// does on text nobody has vetted yet.
const MAX_QUERY_LENGTH = 100_000;

// Where a name is a label (or a relationship type): after the colon, and after
// the operators of a label expression.
const LABEL_POSITION: ReadonlySet<string> = new Set([':', '|', '&', '!']);

type Token =
  /** A bare word (keyword, variable, label, property, function) or a backtick-quoted name. */
  | { kind: 'name'; text: string; quoted: boolean }
  | { kind: 'punct'; text: string }
  /** A string, a number or a parameter: nothing the rules look inside. */
  | { kind: 'value' };

const VALUE: Token = { kind: 'value' };

interface Unreadable {
  reason: string;
}

const PUNCTUATION: ReadonlySet<string> = new Set('!#%&()*+,-./:;<=>?@[]^{|}~');

// A character some reader of the text could take for the end of a line, or a
// control character. Tab, line feed and carriage return are not among them.
const ODD_LINE_BREAK = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/;

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isNameStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isNamePart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** The index just past the number that starts at `start`. */
function endOfNumber(text: string, start: number): number {
  let i = start;
  const skip = (matches: RegExp): void => {
    while (i < text.length && matches.test(text[i]!)) i++;
  };
  const radix = text[i] === '0' ? text[i + 1]?.toLowerCase() : undefined;
  if (radix === 'x' || radix === 'o') {
    i += 2;
    skip(radix === 'x' ? /[0-9A-Fa-f]/ : /[0-7]/);
    return i;
  }
  skip(/[0-9]/);
  if (text[i] === '.' && isDigit(text[i + 1])) {
    i++;
    skip(/[0-9]/);
  }
  if (text[i] === 'e' || text[i] === 'E') {
    const signed = text[i + 1] === '+' || text[i + 1] === '-' ? 1 : 0;
    if (isDigit(text[i + 1 + signed])) {
      i += 1 + signed;
      skip(/[0-9]/);
    }
  }
  return i;
}

/** The name between the backticks that open at `start`, and the index just past it. */
function quotedName(text: string, start: number): { name: string; end: number } | null {
  let name = '';
  let i = start + 1;
  while (i < text.length) {
    if (text[i] !== '`') {
      name += text[i];
      i++;
    } else if (text[i + 1] === '`') {
      // A doubled backtick is a backtick inside the name.
      name += '`';
      i += 2;
    } else {
      return { name, end: i + 1 };
    }
  }
  return null;
}

function tokenize(text: string): Token[] | Unreadable {
  // The database decodes these escapes before it reads the query, anywhere in
  // it, so the text checked here would not be the text that runs.
  if (/\\u/i.test(text)) {
    return {
      reason:
        'Unicode escape sequences (a backslash followed by "u") are not supported in raw queries. Type the character itself, or pass the value as a parameter.',
    };
  }

  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '/' && next === '/') {
      // A line comment ends at a line feed or a carriage return, whichever
      // comes first: ending it early only means more text is checked.
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        if (ODD_LINE_BREAK.test(text[i]!)) {
          return { reason: 'A comment contains a control character or an unusual line break.' };
        }
        i++;
      }
    } else if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return { reason: 'A block comment is never closed.' };
      i = close + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) return { reason: 'A string is never closed.' };
      i++;
      tokens.push(VALUE);
    } else if (c === '`') {
      const quoted = quotedName(text, i);
      if (!quoted) return { reason: 'A backtick-quoted name is never closed.' };
      tokens.push({ kind: 'name', text: quoted.name, quoted: true });
      i = quoted.end;
    } else if (c === '$' && isDigit(next)) {
      // A numbered parameter, $1, ends where its digits do.
      i++;
      while (isDigit(text[i])) i++;
      if (isNamePart(text[i])) return { reason: 'A numbered parameter runs straight into a name.' };
      tokens.push(VALUE);
    } else if (c === '$' && isNameStart(next)) {
      // A named parameter: its name is never a keyword.
      i++;
      while (isNamePart(text[i])) i++;
      tokens.push(VALUE);
    } else if (c === '$' && next === '`') {
      const quoted = quotedName(text, i + 1);
      if (!quoted) return { reason: 'A backtick-quoted name is never closed.' };
      tokens.push(VALUE);
      i = quoted.end;
    } else if (isDigit(c)) {
      const end = endOfNumber(text, i);
      // "1abc" could be read as a number and then a word. Refuse it rather than
      // decide where the database would split it.
      if (isNamePart(text[end])) return { reason: 'A number runs straight into a name.' };
      tokens.push(VALUE);
      i = end;
    } else if (isNameStart(c)) {
      let end = i + 1;
      while (isNamePart(text[end])) end++;
      tokens.push({ kind: 'name', text: text.slice(i, end), quoted: false });
      i = end;
    } else if (PUNCTUATION.has(c) || c === '$') {
      tokens.push({ kind: 'punct', text: c });
      i++;
    } else if (c === '\\') {
      return { reason: 'A backslash is only supported inside a string.' };
    } else {
      return {
        reason:
          'Outside strings, backtick-quoted names and comments, raw queries may contain only plain ASCII characters. Quote the name in backticks, or pass the value as a parameter.',
      };
    }
  }
  return tokens;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

/** The dotted name (a.b.c) that starts at the name token `start`, and the index just past it. */
function dottedName(tokens: readonly Token[], start: number): { name: string; end: number } {
  const first = tokens[start] as Extract<Token, { kind: 'name' }>;
  const segments = [first.text];
  let end = start + 1;
  for (;;) {
    const segment = tokens[end + 1];
    if (!isPunct(tokens[end], '.') || segment?.kind !== 'name') break;
    segments.push(segment.text);
    end += 2;
  }
  return { name: segments.join('.'), end };
}

/**
 * Whether the "(" at `open` starts a subquery's import list, as in
 * CALL (a, b) { ... }: names, commas or a star, then ")" and "{".
 */
function opensImportList(tokens: readonly Token[], open: number): boolean {
  let i = open + 1;
  while (tokens[i]?.kind === 'name' || isPunct(tokens[i], ',') || isPunct(tokens[i], '*')) i++;
  return isPunct(tokens[i], ')') && isPunct(tokens[i + 1], '{');
}

function refuse(
  code: ReadOnlyCypherRefusal,
  message: string,
  keyword?: string,
): ReadOnlyCypherVerdict {
  return keyword === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, keyword };
}

/**
 * What follows the CALL at `call`: a subquery, a listed procedure, or a
 * refusal. `resume` is the index the check carries on from.
 */
function checkCall(
  tokens: readonly Token[],
  call: number,
): { resume: number } | { refusal: ReadOnlyCypherVerdict } {
  const after = tokens[call + 1];
  if (isPunct(after, '{')) return { resume: call + 1 };
  if (isPunct(after, '(') && opensImportList(tokens, call + 1)) return { resume: call + 1 };
  if (after?.kind === 'name') {
    const procedure = dottedName(tokens, call + 1);
    if (ALLOWED_PROCEDURES.has(procedure.name)) return { resume: procedure.end };
    return {
      refusal: refuse(
        'PROCEDURE',
        `Procedure ${procedure.name} is not available to raw queries. The ones that are: ${[...ALLOWED_PROCEDURES].join(', ')}.`,
        'CALL',
      ),
    };
  }
  return {
    refusal: refuse(
      'PROCEDURE',
      'CALL must be followed by a subquery in braces or by one of the procedures available to raw queries.',
      'CALL',
    ),
  };
}

/**
 * Whether a caller-written Cypher query may run on a read-only surface. A
 * refusal carries a message fit to show the caller.
 */
export function checkReadOnlyCypher(cypher: string): ReadOnlyCypherVerdict {
  if (cypher.length > MAX_QUERY_LENGTH) {
    return refuse(
      'TOO_LONG',
      `Raw queries are limited to ${MAX_QUERY_LENGTH.toLocaleString('en-US')} characters. Pass long lists as parameters.`,
    );
  }
  const tokens = tokenize(cypher);
  if (!Array.isArray(tokens)) return refuse('UNREADABLE', tokens.reason);

  // One statement, which may end in a semicolon.
  const last = isPunct(tokens[tokens.length - 1], ';') ? tokens.length - 1 : tokens.length;
  if (last === 0) return refuse('EMPTY', 'The query is empty.');

  for (let i = 0; i < last; i++) {
    const token = tokens[i]!;
    if (isPunct(token, ';')) {
      return refuse('UNREADABLE', 'Raw queries run one statement at a time.');
    }
    if (token.kind !== 'name') continue;
    const before = tokens[i - 1];

    if (
      isInternalLabel(token.text) &&
      before?.kind === 'punct' &&
      LABEL_POSITION.has(before.text)
    ) {
      return refuse(
        'INTERNAL_LABEL',
        'Labels that start with an underscore are internal and are not available to raw queries.',
      );
    }

    if (!token.quoted) {
      const word = token.text.toUpperCase();
      if (WRITE_KEYWORDS.has(word)) {
        return refuse(
          'WRITE_KEYWORD',
          `${word} is not allowed: raw queries are read-only. If it is a name in your graph, quote it in backticks.`,
          word,
        );
      }
      if (word === 'CALL') {
        const call = checkCall(tokens, i);
        if ('refusal' in call) return call.refusal;
        // Past the procedure's name, so it is not also read as a function.
        i = call.resume - 1;
        continue;
      }
    }

    // A dotted name directly before "(" is a call to a namespaced function.
    // Every name starts one unless it is a later segment of the name before
    // it (name, dot, name): a dot alone does not make it one, as in [0..f()].
    const laterSegment = isPunct(before, '.') && tokens[i - 2]?.kind === 'name';
    if (!laterSegment) {
      const called = dottedName(tokens, i);
      if (
        called.name.includes('.') &&
        isPunct(tokens[called.end], '(') &&
        !ALLOWED_FUNCTIONS.has(called.name.toLowerCase())
      ) {
        return refuse(
          'FUNCTION',
          `Function ${called.name} is not available to raw queries. Built-in functions without a namespace are, and so are the date, time, duration, point and vector functions.`,
        );
      }
    }
  }
  return { ok: true };
}
