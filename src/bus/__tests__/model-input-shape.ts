/**
 * #595 r7b: the AST checker behind the "one boundary for model input" shape test.
 *
 * Round 7 pinned the shape with `/ipcServer\??\.send\(/`. Codex showed it misses
 * `this.ipcServer?.send /* c *\/ (...)`, whitespace before `(`, an alias (`const s = this.ipcServer`),
 * a destructure, and any other file. This reads the syntax tree instead, so none of those matter.
 *
 * What it enforces, over every non-test `.ts` file under `src/bus/`:
 *
 * 1. `ipcServer` (the `IpcServer` field of `BusCoreImpl`) may be referenced in exactly these shapes,
 *    and no other. Everything else is a violation, because anything else can carry the server (or
 *    its `send`) to a caller the gate never sees:
 *      - its declaration (`private ipcServer: IpcServer | null`);
 *      - an assignment target (`this.ipcServer = await bindUdsServer(...)`, `= null`);
 *      - the receiver of a CALL to `connectionCount`, `hasConnection` or `stop`;
 *      - the receiver of a CALL to `send`, but only inside `emitModelInput` or `emitControl` of
 *        `BusCoreImpl` in core.ts, one call in each;
 *      - a null or truthiness check: `!x`, `if (x)`, `x ? a : b`, `x === null`, and `&&` / `||` / `??`
 *        chains whose value ends in one of those.
 *    Not allowed: an alias (`const s = this.ipcServer`), a destructure (`const { send } = ...`,
 *    `const { ipcServer } = this`), passing it as an argument, returning it, `.send` read without
 *    being called (`.send.call`, `.send.bind`, `const f = x.send`), a dynamic member (`x[k]`), a bare
 *    `ipcServer` identifier, and the string `"ipcServer"` anywhere but `this["ipcServer"]`.
 *    A comment, whitespace or a newline between `send` and `(` changes nothing here: it is the same node.
 * 2. `bindUdsServer` (which builds a server) is referenced only in core.ts and core-ipc.ts, so no
 *    second server with its own `send` can exist elsewhere in the bus.
 * 3. In core.ts, `recordingPending` is declared once, assigned (the setter) and CALLED exactly once,
 *    inside `modelInputPending`, and `emitModelInput` calls `this.modelInputPending(`.
 *
 * Not caught, and out of scope: a computed key built at runtime (`this[name]`), which no static check
 * can resolve. The type system keeps `ipcServer` private, so reaching it that way takes a cast.
 */
import ts from "typescript";

export interface BusSource {
  /** Path relative to `src/bus/`, e.g. `core.ts`. */
  name: string;
  text: string;
}

export interface BoundaryReport {
  /** One line per breach: `file:line: reason`. Empty when the shape holds. */
  violations: string[];
  /** `file#Class.method` of every call to `ipcServer.send`, sorted. */
  sendSites: string[];
  /** `file#Class.method` of every call to `recordingPending`, sorted. */
  pendingReaders: string[];
  /** How many `ipcServer` references were classified: a non-zero floor proves the scan saw the code. */
  ipcServerReferences: number;
}

const SENDER_FILE = "core.ts";
const SENDER_CLASS = "BusCoreImpl";
const SEND_METHODS = ["emitModelInput", "emitControl"] as const;
/** Server methods that read state or end its life; none of them writes a frame. */
const NON_SENDING_CALLS = new Set(["connectionCount", "hasConnection", "stop"]);
/** The only files that may name `bindUdsServer`: the definition and its one caller. */
const SERVER_BUILDER_FILES = new Set(["core.ts", "core-ipc.ts"]);

const wrapsExpression = (n: ts.Node): boolean =>
  ts.isParenthesizedExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isTypeAssertionExpression(n) ||
  ts.isSatisfiesExpression(n);

/** Climb out of `( )`, `!`, `as T`, `<T>` and `satisfies T`: they change no value. */
function outermost(node: ts.Node): ts.Node {
  let cur = node;
  while (cur.parent && wrapsExpression(cur.parent)) cur = cur.parent;
  return cur;
}

/** The inverse of `outermost`: step down through the same wrappers. */
function innermost(node: ts.Expression): ts.Expression {
  let cur = node;
  while (wrapsExpression(cur)) cur = (cur as ts.ParenthesizedExpression).expression;
  return cur;
}

/** `x.name` or `x["name"]`; null for a computed key that is not a string literal. */
function memberName(n: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  const arg = n.argumentExpression;
  return ts.isStringLiteralLike(arg) ? arg.text : null;
}

const isMemberAccess = (
  n: ts.Node,
): n is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const isPlainAssignmentTarget = (top: ts.Node): boolean =>
  !!top.parent &&
  ts.isBinaryExpression(top.parent) &&
  top.parent.left === top &&
  top.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;

/**
 * True when the node's value is consumed only as a truth value or compared: `!x`, `if (x)`,
 * `x ? a : b`, `x === null`. `x && y` is safe when x is the left operand (the result is then x only
 * when x is null, or y). `x || y`, `x ?? y` and `y && x` can hand x on, so they count only when the
 * whole expression is itself consumed that way.
 */
function consumedAsCondition(node: ts.Node): boolean {
  let cur = outermost(node);
  for (;;) {
    const p = cur.parent;
    if (!p) return false;
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isIfStatement(p) && p.expression === cur) return true;
    if (ts.isConditionalExpression(p) && p.condition === cur) return true;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (COMPARISONS.has(op)) return true;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.left === cur) return true;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        cur = outermost(p);
        continue;
      }
    }
    return false;
  }
}

/** `Class.method` that lexically contains the node (a closure inside the method counts as inside). */
function enclosingMethod(node: ts.Node): { cls: string; method: string } | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      const owner = cur.parent;
      const cls = ts.isClassLike(owner) && owner.name ? owner.name.text : "<anonymous>";
      return { cls, method: cur.name.text };
    }
  }
  return null;
}

/** How many calls under `root` have `this.<name>` as the callee. */
function callsToThisMethod(root: ts.Node, name: string): number {
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = innermost(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
        callee.name.text === name
      ) {
        n++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return n;
}

function findMethod(sf: ts.SourceFile, cls: string, method: string): ts.MethodDeclaration | null {
  let found: ts.MethodDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === cls) {
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === method) {
          found = m;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Visit every mention of `name` and sort it into a reference (`onRef`: a property access, an
 * element access, or the property's own declaration) or a stray (`onStray`: a binding, a bare
 * identifier, a stray string). Keys and member declarations of other types are not mentions.
 */
function forEachReference(
  sf: ts.SourceFile,
  name: string,
  onRef: (ref: ts.Node) => void,
  onStray: (node: ts.Node, what: string) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.name === node) onRef(p);
      else if (p && ts.isPropertyDeclaration(p) && p.name === node) onRef(node);
      else if (
        p &&
        ((ts.isPropertyAssignment(p) && p.name === node) ||
          ts.isPropertySignature(p) ||
          ts.isMethodSignature(p) ||
          ts.isMethodDeclaration(p))
      ) {
        // A key or a member declaration of another type: names the word, reaches nothing.
      } else if (p && ts.isBindingElement(p)) onStray(node, "destructured out of an object");
      else onStray(node, `bare \`${name}\` identifier`);
    } else if (ts.isStringLiteralLike(node) && node.text === name) {
      const p = node.parent;
      if (p && ts.isElementAccessExpression(p) && p.argumentExpression === node) onRef(p);
      else onStray(node, `the string "${name}" outside \`x["${name}"]\``);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Run the boundary checks over the given sources. */
export function checkModelInputBoundary(sources: BusSource[]): BoundaryReport {
  const violations: string[] = [];
  const sendSites: string[] = [];
  const pendingReaders: string[] = [];
  let ipcServerReferences = 0;

  for (const src of sources) {
    const sf = ts.createSourceFile(
      src.name,
      src.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const at = (node: ts.Node): string =>
      `${src.name}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const breach = (node: ts.Node, why: string): void => {
      violations.push(`${at(node)}: ${why}`);
    };
    const siteOf = (node: ts.Node): { label: string; cls?: string; method?: string } => {
      const where = enclosingMethod(node);
      return where
        ? { label: `${src.name}#${where.cls}.${where.method}`, ...where }
        : { label: `${src.name}#<top level>` };
    };

    // 1. ipcServer
    const classifyIpc = (ref: ts.Node): void => {
      ipcServerReferences++;
      if (ts.isIdentifier(ref)) return; // the declaration itself
      const top = outermost(ref);
      if (isPlainAssignmentTarget(top)) return;
      const parent = top.parent;
      if (parent && isMemberAccess(parent) && parent.expression === top) {
        const member = memberName(parent);
        const callee = outermost(parent);
        const call = callee.parent;
        const called = !!call && ts.isCallExpression(call) && call.expression === callee;
        if (called && member === "send") {
          const site = siteOf(call);
          sendSites.push(site.label);
          const allowed =
            src.name === SENDER_FILE &&
            site.cls === SENDER_CLASS &&
            (SEND_METHODS as readonly string[]).includes(site.method ?? "");
          if (!allowed) {
            breach(
              call,
              `ipcServer.send called from ${site.label}; only emitModelInput and emitControl may send`,
            );
          }
        } else if (called && member !== null && NON_SENDING_CALLS.has(member)) {
          // lifecycle and state reads
        } else {
          breach(
            parent,
            `ipcServer.${member ?? "[computed]"} used other than as a call to ${[...NON_SENDING_CALLS].join("/")}, or to send inside the two emitters`,
          );
        }
        return;
      }
      if (consumedAsCondition(top)) return;
      breach(
        ref,
        "ipcServer escapes: aliased, destructured, passed, returned or otherwise read as a value",
      );
    };
    forEachReference(sf, "ipcServer", classifyIpc, (node, what) =>
      breach(node, `ipcServer ${what}`),
    );

    // 2. bindUdsServer
    if (!SERVER_BUILDER_FILES.has(src.name)) {
      const second = (node: ts.Node): void =>
        breach(node, "bindUdsServer outside core.ts / core-ipc.ts: a second server could send");
      forEachReference(sf, "bindUdsServer", second, second);
    }

    if (src.name !== SENDER_FILE) continue;

    // 3. recordingPending (a field of BusCoreImpl; other bus classes have methods of that name)
    forEachReference(
      sf,
      "recordingPending",
      (ref) => {
        if (ts.isIdentifier(ref)) return; // the declaration
        const top = outermost(ref);
        if (isPlainAssignmentTarget(top)) return; // the setter
        const call = top.parent;
        if (call && ts.isCallExpression(call) && call.expression === top) {
          const site = siteOf(call);
          pendingReaders.push(site.label);
          if (site.cls !== SENDER_CLASS || site.method !== "modelInputPending") {
            breach(
              call,
              `recordingPending read from ${site.label}; only modelInputPending may read it`,
            );
          }
        } else {
          breach(
            ref,
            "recordingPending escapes: aliased, destructured, passed or read without a call",
          );
        }
      },
      (node, what) => breach(node, `recordingPending ${what}`),
    );

    // The gate itself: emitModelInput consults modelInputPending.
    const gate = findMethod(sf, SENDER_CLASS, "emitModelInput");
    if (!gate) violations.push(`${src.name}: ${SENDER_CLASS}.emitModelInput not found`);
    else if (callsToThisMethod(gate, "modelInputPending") < 1) {
      breach(gate, "emitModelInput does not call this.modelInputPending()");
    }
  }

  const sortedSends = [...sendSites].sort();
  const expectedSends = SEND_METHODS.map((m) => `${SENDER_FILE}#${SENDER_CLASS}.${m}`).sort();
  if (sortedSends.join(",") !== expectedSends.join(",")) {
    violations.push(
      `ipcServer.send call sites are [${sortedSends.join(", ")}], expected exactly [${expectedSends.join(", ")}]`,
    );
  }
  const expectedReader = `${SENDER_FILE}#${SENDER_CLASS}.modelInputPending`;
  if (pendingReaders.length !== 1 || pendingReaders[0] !== expectedReader) {
    violations.push(
      `recordingPending readers are [${pendingReaders.join(", ")}], expected exactly [${expectedReader}]`,
    );
  }

  return {
    violations,
    sendSites: sortedSends,
    pendingReaders: [...pendingReaders].sort(),
    ipcServerReferences,
  };
}
