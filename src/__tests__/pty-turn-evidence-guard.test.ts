/**
 * Guard for the PTY turn-evidence rule (#562 rounds 2 and 3; `.planning/pty-migration/SPEC.md`,
 * CLAUDE.md "PTY turn evidence"):
 *
 *   The screen is never evidence that a prompt was accepted, that a turn finished, or of
 *   what the answer was. Only the session transcript is. The screen may be used for
 *   readiness, dialogs and liveness, and only to stop or fail a turn, never to mark it
 *   successful.
 *
 * The modules that DECIDE a turn's outcome or BUILD its returned answer must therefore not
 * reach the screen parser's completion/answer API. That API is the sentinel round trip and
 * the screen-to-text extractors in `pty-output-parser.ts`.
 *
 * Round 2 scanned the four modules' text for those names. That misses a renamed re-export
 * (`export { feed as harmless }`), a namespace barrel (`export * as P`), a dynamic import and
 * a wrapper module that calls the parser on the success path's behalf. So this guard asks
 * the TypeScript compiler instead: it builds the module graph from the four modules (its
 * own module resolution, so barrels and `export *` are followed), and in every module that
 * graph reaches it resolves each identifier through any chain of aliases to the symbol it
 * finally names. An identifier that ends at a forbidden symbol of the parser is a violation,
 * wherever it is written and whatever it was renamed to.
 *
 * A re-export that nobody on the graph uses is pass-through and not flagged (the barrel
 * `src/runner/index.ts` re-exports the parser for tests and other callers).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

/** Modules that decide whether a turn succeeded or build the answer it returns. */
const SUCCESS_DECIDING_MODULES = [
  "src/runner/pty-process.ts",
  "src/runner/pty-transcript.ts",
  "src/runner/pty-supervisor.ts",
  "src/runner/live-session-actions.ts",
] as const;

/**
 * The parser's completion/answer API: the pieces that turn screen bytes into "the prompt was
 * taken", "the turn is over" or "this is the answer".
 *
 *   createParser / startTurn / feed / tick / markSentinelWritten / resetTurn   the state machine
 *   buildSentinel / encodeSentinel                                              the sentinel echo
 *   extractResponseText / decodeTurn / normaliseNewlines                        screen → answer text
 *   Parser / ParserEvent / ParserState                                          its state types
 *
 * NOT forbidden: `stripAnsi` (boot-screen and dialog matching in `_waitForReadySettle`, a
 * readiness use) and `DEFAULT_QUIET_WINDOW_MS`.
 */
export const FORBIDDEN_PARSER_SYMBOLS: ReadonlySet<string> = new Set([
  "createParser",
  "startTurn",
  "feed",
  "tick",
  "markSentinelWritten",
  "resetTurn",
  "buildSentinel",
  "encodeSentinel",
  "extractResponseText",
  "decodeTurn",
  "normaliseNewlines",
  "Parser",
  "ParserEvent",
  "ParserState",
]);

/** What the four success-deciding modules themselves may take from the parser. */
const ALLOWED_DIRECT_PARSER_SYMBOLS: ReadonlySet<string> = new Set([
  "stripAnsi",
  "DEFAULT_QUIET_WINDOW_MS",
]);

const PARSER_FILE = /(^|\/)pty-output-parser\.ts$/;

export interface Violation {
  file: string;
  line: number;
  what: string;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  // The standard lib is loaded so `await import("./x")` has a Promise to unwrap and a
  // property access on the result can be resolved to the symbol it names.
  lib: ["lib.es2022.d.ts"],
};

/**
 * Violations reachable from `roots`. `directRoots` are the modules held to the stricter rule
 * (nothing from the parser but the readiness helpers); every module on the graph is held to
 * the forbidden-symbol rule.
 */
export function graphViolations(
  roots: readonly string[],
  options: ts.CompilerOptions = COMPILER_OPTIONS,
): Violation[] {
  const program = ts.createProgram([...roots], options);
  const checker = program.getTypeChecker();
  const isParserFile = (f: ts.SourceFile | undefined): boolean =>
    f !== undefined && PARSER_FILE.test(f.fileName);
  const rootSet = new Set(roots.map((r) => ts.sys.resolvePath(r)));
  const found: Violation[] = [];

  /** The symbol an alias chain finally names. */
  const resolve = (sym: ts.Symbol): ts.Symbol =>
    sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

  /** The parser symbol `sym` ends at, as its exported name; `*` for the parser module itself. */
  const parserTarget = (sym: ts.Symbol | undefined): string | null => {
    if (!sym) return null;
    let target: ts.Symbol;
    try {
      target = resolve(sym);
    } catch {
      return null;
    }
    const decls = target.declarations ?? [];
    for (const d of decls) {
      if (!isParserFile(d.getSourceFile())) continue;
      return ts.isSourceFile(d) ? "*" : target.name;
    }
    return null;
  };

  /** Whether any member of `type` finally names a forbidden symbol of the parser. */
  const exposesForbidden = (type: ts.Type): boolean =>
    type.getProperties().some((p) => {
      const name = parserTarget(p);
      return name !== null && name !== "*" && FORBIDDEN_PARSER_SYMBOLS.has(name);
    });

  /**
   * A use of a module-namespace value (`import * as B`, `await import(..)`) that exposes the
   * parser's completion API, other than the three shapes judged member by member: `B.x`,
   * `B["x"]` and a destructuring source. Handed on, cast (`B as Record<..>`), spread or
   * passed to `Object.values`, it can reach any member, so it is a violation.
   */
  const isUnjudgedNamespaceUse = (node: ts.Identifier): boolean => {
    const p = node.parent;
    if (ts.isVariableDeclaration(p) && p.name === node) return false;
    if (ts.isPropertyAccessExpression(p) && p.expression === node) return false;
    if (ts.isElementAccessExpression(p) && p.expression === node) return false;
    if (ts.isVariableDeclaration(p) && p.initializer === node && ts.isObjectBindingPattern(p.name))
      return false;
    const type = checker.getTypeAtLocation(node);
    return ((type.symbol?.flags ?? 0) & ts.SymbolFlags.ValueModule) !== 0 && exposesForbidden(type);
  };

  const report = (sf: ts.SourceFile, node: ts.Node, what: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ file: sf.fileName, line: line + 1, what });
  };

  /**
   * Names inside an import/export specifier (both sides of `a as b`) are not uses. An import
   * specifier is judged on its own, below; an export specifier or `export * as P` is
   * pass-through, and flagged only where something on the graph imports it.
   */
  const isSpecifierName = (node: ts.Identifier): boolean => {
    const p = node.parent;
    return (
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p) ||
      ts.isNamespaceExport(p) ||
      (ts.isNamespaceImport(p) && p.name === node)
    );
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || isParserFile(sf) || sf.fileName.includes("/node_modules/"))
      continue;
    const direct = rootSet.has(ts.sys.resolvePath(sf.fileName));

    const visit = (node: ts.Node): void => {
      // `import { x } from ...`: the binding is judged by what it finally names.
      if (ts.isImportSpecifier(node)) {
        const name = parserTarget(checker.getSymbolAtLocation(node.name));
        if (name === "*") {
          report(sf, node, "imports the parser module itself");
        } else if (name !== null) {
          if (FORBIDDEN_PARSER_SYMBOLS.has(name)) {
            report(sf, node, `imports ${name} (as ${node.name.text}), which is the parser's`);
          } else if (direct && !ALLOWED_DIRECT_PARSER_SYMBOLS.has(name)) {
            report(sf, node, `imports ${name} from the parser, which is not a readiness helper`);
          }
        }
      } else if (ts.isNamespaceImport(node)) {
        // `import * as P from X`: X may be the parser, or a barrel; uses of P.<member> are
        // judged below. The parser itself is flagged outright.
        const name = parserTarget(checker.getSymbolAtLocation(node.name));
        if (name === "*") report(sf, node, "namespace import of the parser");
      } else if (ts.isCallExpression(node)) {
        // `import("x")` / `require("x")`: a specifier that resolves to the parser.
        const callee = node.expression;
        const dynamic =
          callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require");
        const arg = node.arguments[0];
        if (dynamic && arg && ts.isStringLiteralLike(arg)) {
          const resolved = ts.resolveModuleName(arg.text, sf.fileName, options, ts.sys)
            .resolvedModule?.resolvedFileName;
          if (resolved && PARSER_FILE.test(resolved)) {
            report(sf, node, `dynamic import of the parser (${arg.text})`);
          }
        }
      } else if (ts.isIdentifier(node) && !isSpecifierName(node)) {
        // Any use: `feed(...)`, `P.feed`, `ns.harmless`. A use of the parser's namespace
        // object (passed around) is flagged too: nothing can be said of what it reaches.
        const name = parserTarget(checker.getSymbolAtLocation(node));
        if (name === "*") {
          report(sf, node, `uses the parser module's namespace (${node.text})`);
        } else if (name !== null && FORBIDDEN_PARSER_SYMBOLS.has(name)) {
          report(sf, node, `uses ${name} (as ${node.text}), which is the parser's`);
        } else if (name === null && isUnjudgedNamespaceUse(node)) {
          report(sf, node, `${node.text} is a namespace that exposes the parser's API, used whole`);
        }
      } else if (ts.isElementAccessExpression(node)) {
        // `B["extractResponseText"]`: a literal key is looked up on the value's type and
        // judged like a property access. Any other key (`B[name]`) cannot be resolved, so it
        // is a violation when the value exposes a forbidden symbol at all.
        const type = checker.getTypeAtLocation(node.expression);
        const key = node.argumentExpression;
        if (ts.isStringLiteralLike(key)) {
          const name = parserTarget(type.getProperty(key.text));
          if (name !== null && name !== "*" && FORBIDDEN_PARSER_SYMBOLS.has(name)) {
            report(sf, node, `uses ${name} through ["${key.text}"], which is the parser's`);
          }
        } else if (exposesForbidden(type)) {
          report(sf, node, "computed access on a value that exposes the parser's completion API");
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // `const { feed } = P`: the property is looked up on the destructured value's type.
        const decl = node.parent.parent;
        const source = ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
        const key = (node.propertyName ?? node.name) as ts.Node;
        if (source && node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
          // `const { [k]: f } = B`: the same unresolvable access, spelled as a pattern.
          if (exposesForbidden(checker.getTypeAtLocation(source))) {
            report(sf, node, "computed destructuring of a value that exposes the parser's API");
          }
        } else if (source && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) {
          const prop = checker.getTypeAtLocation(source).getProperty(key.text);
          const name = parserTarget(prop);
          if (name !== null && name !== "*" && FORBIDDEN_PARSER_SYMBOLS.has(name)) {
            report(sf, node, `destructures ${name}, which is the parser's`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

const root = join(import.meta.dir, "..", "..");

describe("PTY turn evidence: nothing the success-deciding modules reach uses the screen parser's completion API", () => {
  test("the real module graph is clean", () => {
    // Fault: add `import { feed } from "./pty-output-parser"` (or any forbidden name, under
    // any alias, in any module those four reach) and this list is no longer empty.
    const violations = graphViolations(SUCCESS_DECIDING_MODULES.map((m) => join(root, m)));
    expect(violations).toEqual([]);
  }, 120_000);

  test("the guard names the modules that exist (a renamed file must not silently drop out)", () => {
    for (const rel of SUCCESS_DECIDING_MODULES) {
      expect(ts.sys.fileExists(join(root, rel))).toBe(true);
    }
  });
});

describe("the guard itself can fail", () => {
  /**
   * A fake `src/` on disk: the parser, whatever the fixture adds, and a `main.ts` root. By
   * default the fixture's `main.ts` is moved to `mid.ts`, a module the root merely reaches, so
   * the shape is judged by the graph rule; `direct` keeps it in the root, which is also held
   * to "nothing but the readiness helpers".
   */
  function violationsOf(
    files: Record<string, string>,
    opts: { direct?: boolean } = {},
  ): Violation[] {
    const dir = mkdtempSync(join(tmpdir(), "pty-guard-"));
    try {
      const all: Record<string, string> = {
        "pty-output-parser.ts": [
          "export function feed(): void {}",
          "export function tick(): void {}",
          "export function extractResponseText(): string { return ''; }",
          "export function decodeTurn(): string { return ''; }",
          "export function stripAnsi(s: string): string { return s; }",
          "export function expandCursorForwardToSpaces(s: string): string { return s; }",
          "export interface Parser { x: number }",
        ].join("\n"),
        ...files,
      };
      if (!opts.direct && all["main.ts"] !== undefined) {
        all["mid.ts"] = `${all["main.ts"]}\nexport const touch = (): void => {};`;
        all["main.ts"] = `import { touch } from "./mid";\ntouch();`;
      }
      for (const [name, text] of Object.entries(all)) {
        const path = join(dir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      return graphViolations([join(dir, "main.ts")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const bad: Array<[string, Record<string, string>, { direct?: boolean }?]> = [
    [
      "a named import in a guarded module",
      { "main.ts": `import { feed } from "./pty-output-parser";\nfeed();` },
      { direct: true },
    ],
    [
      "a named import in a module the guarded ones reach",
      { "main.ts": `import { feed } from "./pty-output-parser";\nfeed();` },
    ],
    [
      "an aliased import",
      { "main.ts": `import { decodeTurn as d } from "./pty-output-parser";\nd();` },
    ],
    [
      "a type-only import of parser state",
      { "main.ts": `import type { Parser } from "./pty-output-parser";\nexport type X = Parser;` },
    ],
    ["a namespace import", { "main.ts": `import * as P from "./pty-output-parser";\nP.feed();` }],
    [
      "a namespace import passed on without naming a member",
      {
        "main.ts": `import * as P from "./pty-output-parser";\nexport const keep = (x: unknown) => x;\nkeep(P);`,
      },
    ],
    [
      "a dynamic import",
      { "main.ts": `export const p = await import("./pty-output-parser");\np.feed();` },
    ],
    [
      "a dynamic import of the parser whose result is not used",
      { "main.ts": `export const loaded = import("./pty-output-parser");` },
    ],
    ["a require", { "main.ts": `const p = require("./pty-output-parser");\nvoid p;` }],
    [
      "a multi-line import",
      {
        "main.ts": `import {\n  stripAnsi,\n  extractResponseText,\n} from "./pty-output-parser";\nextractResponseText();\nstripAnsi("");`,
      },
    ],
    [
      "a parser helper that is not on the readiness allow-list, in a guarded module",
      {
        "main.ts": `import { expandCursorForwardToSpaces } from "./pty-output-parser";\nexpandCursorForwardToSpaces("");`,
      },
      { direct: true },
    ],
    // The shapes a text scan cannot see (round 3, M3):
    [
      "a RENAMED re-export through a barrel",
      {
        "barrel.ts": `export { feed as harmless } from "./pty-output-parser";`,
        "main.ts": `import { harmless } from "./barrel";\nharmless();`,
      },
    ],
    [
      "a renamed re-export two barrels deep",
      {
        "inner.ts": `export { tick as quiet } from "./pty-output-parser";`,
        "outer.ts": `export { quiet as calm } from "./inner";`,
        "main.ts": `import { calm } from "./outer";\ncalm();`,
      },
    ],
    [
      "a namespace barrel (`export * as P`)",
      {
        "barrel.ts": `export * as P from "./pty-output-parser";`,
        "main.ts": `import { P } from "./barrel";\nP.feed();`,
      },
    ],
    [
      "a star barrel used through a namespace import",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `import * as B from "./barrel";\nB.extractResponseText();`,
      },
    ],
    [
      "a star barrel destructured",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `import * as B from "./barrel";\nconst { decodeTurn } = B;\ndecodeTurn();`,
      },
    ],
    // The shapes a property-name scan cannot see (round 4, M3):
    [
      "element access through a star-barrel namespace import",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `import * as B from "./barrel";\nB["extractResponseText"]();`,
      },
    ],
    [
      "element access through a namespace barrel (`export * as P`)",
      {
        "barrel.ts": `export * as P from "./pty-output-parser";`,
        "main.ts": `import { P } from "./barrel";\nP["feed"]();`,
      },
    ],
    [
      "element access on a dynamically imported barrel",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `const b = await import("./barrel");\nexport const r = b["decodeTurn"]();`,
      },
    ],
    [
      "an unresolvable computed access on a namespace that exposes the parser's API",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `import * as B from "./barrel";\nconst k = process.argv[2] as string;\n(B as Record<string, () => void>)[k]?.();\nexport const r = (B as unknown as Record<string, () => string>)[k]!();`,
      },
    ],
    [
      "a key built at run time on a star-barrel namespace",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `import * as B from "./barrel";\nexport const r = B["extract" + "ResponseText"]();`,
      },
    ],
    [
      "computed destructuring of a namespace that exposes the parser's API",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `import * as B from "./barrel";\nconst k = "decodeTurn";\nconst { [k]: f } = B;\nvoid f;`,
      },
    ],
    [
      "a dynamic import of a barrel",
      {
        "barrel.ts": `export * from "./pty-output-parser";`,
        "main.ts": `const b = await import("./barrel");\nexport const r = b.feed();`,
      },
    ],
    [
      "a wrapper module that calls the parser for the success path",
      {
        "wrapper.ts": `import { feed } from "./pty-output-parser";\nexport const wrapped = (): void => feed();`,
        "main.ts": `import { wrapped } from "./wrapper";\nwrapped();`,
      },
    ],
    [
      "a wrapper that reaches the parser through a renamed barrel export",
      {
        "barrel.ts": `export { decodeTurn as plain } from "./pty-output-parser";`,
        "wrapper.ts": `import { plain } from "./barrel";\nexport const wrapped = (): string => plain();`,
        "main.ts": `import { wrapped } from "./wrapper";\nwrapped();`,
      },
    ],
  ];
  for (const [label, files, opts] of bad) {
    test(`flags ${label}`, () => {
      expect(violationsOf(files, opts).length).toBeGreaterThan(0);
    });
  }

  test("allows the readiness helper, a pass-through barrel nobody uses, and unrelated code", () => {
    expect(
      violationsOf({
        "barrel.ts": `export * from "./pty-output-parser";\nexport { feed as unusedAlias } from "./pty-output-parser";`,
        "main.ts": `import { stripAnsi } from "./pty-output-parser";\nimport { join } from "./other";\nexport const x = stripAnsi(join("a"));`,
        "other.ts": `export const join = (s: string): string => s;`,
      }),
    ).toEqual([]);
  });

  test("element access that names a harmless member, or on a value that exposes nothing forbidden, is not a violation", () => {
    expect(
      violationsOf({
        "barrel.ts": `export * from "./pty-output-parser";\nexport const unrelated = 1;`,
        "other.ts": `export const join = (s: string): string => s;\nexport const rest = 2;`,
        "main.ts": [
          `import * as B from "./barrel";`,
          `import * as O from "./other";`,
          `const k = process.argv[2] as string;`,
          `export const a = B["unrelated"];`,
          `export const b = B["stripAnsi"]("");`,
          `export const c = (O as Record<string, unknown>)[k];`,
          `export const d = O["join"]("x");`,
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  test("a barrel that is imported for something else is not a violation", () => {
    expect(
      violationsOf({
        "barrel.ts": `export * from "./pty-output-parser";\nexport const unrelated = 1;`,
        "main.ts": `import { unrelated } from "./barrel";\nexport const y = unrelated;`,
      }),
    ).toEqual([]);
  });
});
