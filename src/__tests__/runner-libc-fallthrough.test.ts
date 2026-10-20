import { describe, expect, it } from "bun:test";
import { dlopen as realDlopen } from "bun:ffi";
import { dlopenLibc, _readNativeEnvironmentWithDlopenForTests, libcCandidates } from "../runner";

// #570 r15d (Codex P2): readNativeEnvironment hard-coded `libc.so.6`, so on musl every
// untrusted one-shot threw before it spawned. loadLibc and readNativeEnvironment now share
// one candidate list through dlopenLibc, which falls through to the next candidate.
describe("dlopenLibc", () => {
  it("falls through to the second candidate when the first does not open (musl)", () => {
    const tried: string[] = [];
    const lib = { symbols: { marker: "second" } };
    const dlopen = (path: string) => {
      tried.push(path);
      if (path === "libc.so.6") throw new Error("cannot open shared object file");
      return lib;
    };
    expect(dlopenLibc(dlopen, {}, ["libc.so.6", "libc.so"])).toBe(lib);
    expect(tried).toEqual(["libc.so.6", "libc.so"]);
  });

  it("stops at the first candidate that opens", () => {
    const tried: string[] = [];
    const dlopen = (path: string) => {
      tried.push(path);
      return { path };
    };
    expect(dlopenLibc(dlopen, {}, ["a", "b"])).toEqual({ path: "a" });
    expect(tried).toEqual(["a"]);
  });

  it("throws the last dlopen error when no candidate opens (fail closed)", () => {
    const dlopen = (path: string) => {
      throw new Error(`no ${path}`);
    };
    expect(() => dlopenLibc(dlopen, {}, ["a", "b"])).toThrow("no b");
  });

  it("passes the symbol table through untouched", () => {
    const symbols = { dlsym: {} };
    let seen: unknown;
    dlopenLibc(
      (_path: string, table: unknown) => {
        seen = table;
        return {};
      },
      symbols,
      ["x"],
    );
    expect(seen).toBe(symbols);
  });
});

describe("readNativeEnvironment libc fallthrough", () => {
  it("reads environ when the first libc candidate does not open (musl)", () => {
    const [first, second] = libcCandidates();
    const tried: string[] = [];
    // The first candidate fails like libc.so.6 does on musl; the second maps to the first
    // real path so this also works on a glibc host that has no plain `libc.so`.
    const dlopen = (path: string, symbols: Parameters<typeof realDlopen>[1]) => {
      tried.push(path);
      if (path === first) throw new Error("cannot open shared object file");
      return realDlopen(first, symbols);
    };
    const native = _readNativeEnvironmentWithDlopenForTests(dlopen);
    expect(tried).toEqual([first, second]);
    expect(native.has("PATH")).toBe(true);
  });

  it("stays fail-closed when no libc candidate opens", () => {
    const dlopen = () => {
      throw new Error("cannot open shared object file");
    };
    expect(() => _readNativeEnvironmentWithDlopenForTests(dlopen)).toThrow(
      "Native environment isolation unavailable",
    );
  });
});
