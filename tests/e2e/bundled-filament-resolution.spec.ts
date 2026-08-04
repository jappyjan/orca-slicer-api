/**
 * `GET /profiles/bundled` — the resolution paths that used to fail quietly.
 *
 * Three separate silent failures are pinned here:
 *
 *  1. **Slash-named ancestors.** Some bundled profiles declare a `name` with a
 *     literal `/` while the file on disk substitutes something else — and the
 *     substitute is not consistent (`PA/PET` -> `PA PET`, `PLA/PETG` ->
 *     `PLA-PETG`). Deriving the parent's path from the `inherits` string made
 *     the `/` act as a directory separator; the read ENOENTed and the entire
 *     remaining ancestor chain was dropped without a word.
 *
 *  2. **`filament_vendor`.** It sits on the family base, one hop up the chain
 *     the walk already traverses, and was simply never read.
 *
 *  3. **Silent degrade.** A preset whose chain cannot be resolved falls back
 *     to leaf-only metadata rather than failing the listing — correct, but it
 *     used to leave no trace, so a systematic resolution failure would present
 *     as the endpoint quietly answering all-`null` again.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { MockInstance } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "./setup";

type Entry = {
  name: string;
  filament_type: string | null;
  filament_colour: string | null;
  filament_vendor: string | null;
};

let root: string;
let previousPath: string | undefined;

function write(dir: string, file: string, json: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(json), "utf8");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-resolution-"));
  const filament = path.join(root, "filament");
  fs.mkdirSync(filament);
  fs.mkdirSync(path.join(root, "machine"));
  fs.mkdirSync(path.join(root, "process"));

  // --- vendor one hop up a plain chain ------------------------------------
  write(filament, "fdm_filament_abs", {
    name: "fdm_filament_abs",
    instantiation: "false",
    filament_type: ["ABS"],
  });
  write(filament, "Bambu ABS @base", {
    name: "Bambu ABS @base",
    inherits: "fdm_filament_abs",
    instantiation: "false",
    filament_vendor: ["Bambu Lab"],
    default_filament_colour: ["#000000"],
  });
  write(filament, "Bambu ABS @BBL H2S", {
    name: "Bambu ABS @BBL H2S",
    inherits: "Bambu ABS @base",
    instantiation: "true",
  });

  // --- vendor genuinely absent / empty / not a string ----------------------
  write(filament, "Generic PLA @BBL H2S", {
    name: "Generic PLA @BBL H2S",
    instantiation: "true",
    filament_type: ["PLA"],
  });
  write(filament, "Empty Vendor @BBL H2S", {
    name: "Empty Vendor @BBL H2S",
    instantiation: "true",
    filament_type: ["PLA"],
    filament_vendor: "",
  });
  write(filament, "Numeric Vendor @BBL H2S", {
    name: "Numeric Vendor @BBL H2S",
    instantiation: "true",
    filament_type: ["PLA"],
    filament_vendor: [42],
  });

  // --- slash-named ancestor, sanitization "/" -> " " -----------------------
  write(filament, "Bambu Support For PA PET @base", {
    name: "Bambu Support For PA/PET @base",
    instantiation: "false",
    filament_type: ["PA"],
    filament_vendor: ["Bambu Lab"],
    default_filament_colour: ["#FFFFFF"],
  });
  write(filament, "Bambu Support For PA PET @BBL X1C", {
    name: "Bambu Support For PA/PET @BBL X1C",
    inherits: "Bambu Support For PA/PET @base",
    instantiation: "true",
  });

  // --- slash-named ancestor, sanitization "/" -> "-" -----------------------
  write(filament, "Bambu Support For PLA-PETG @base", {
    name: "Bambu Support For PLA/PETG @base",
    instantiation: "false",
    filament_type: ["PLA"],
    filament_vendor: ["Bambu Lab"],
  });
  write(filament, "Bambu Support For PLA-PETG @BBL X1C", {
    name: "Bambu Support For PLA/PETG @BBL X1C",
    inherits: "Bambu Support For PLA/PETG @base",
    instantiation: "true",
  });

  // --- degrade: cyclic ancestors hit the depth cap and throw ---------------
  write(filament, "cycle_a", {
    name: "cycle_a",
    instantiation: "false",
    inherits: "cycle_b",
  });
  write(filament, "cycle_b", {
    name: "cycle_b",
    instantiation: "false",
    inherits: "cycle_a",
    // If any of this leaked into the leaf the degrade would be reporting
    // half-resolved data, which is worse than leaf-only.
    filament_type: ["ASA"],
    filament_vendor: ["Ghost Vendor"],
  });
  write(filament, "Cyclic @BBL H2S", {
    name: "Cyclic @BBL H2S",
    inherits: "cycle_a",
    instantiation: "true",
    filament_type: ["TPU"],
  });

  // --- degrade: corrupt ancestor -------------------------------------------
  fs.writeFileSync(
    path.join(filament, "broken_base.json"),
    "{ not valid json",
    "utf8",
  );
  write(filament, "Corrupt Ancestor @BBL H2S", {
    name: "Corrupt Ancestor @BBL H2S",
    inherits: "broken_base",
    instantiation: "true",
    filament_type: ["PC"],
  });

  previousPath = process.env.BUNDLED_PROFILES_PATH;
  process.env.BUNDLED_PROFILES_PATH = root;
});

afterAll(() => {
  if (previousPath === undefined) delete process.env.BUNDLED_PROFILES_PATH;
  else process.env.BUNDLED_PROFILES_PATH = previousPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /profiles/bundled — inheritance resolution", () => {
  let byName: Map<string, Entry>;
  let warnSpy: MockInstance<typeof console.warn>;
  let infoSpy: MockInstance<typeof console.info>;

  beforeAll(async () => {
    // The listing sits behind a 1h in-process cache, so the spies must be in
    // place before the one request that actually builds it.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await request.get("/profiles/bundled").expect(200);
    byName = new Map(
      (res.body.filament as Entry[]).map((f) => [f.name, f] as const),
    );
  });

  afterAll(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("resolves a parent whose file substitutes a space for the name's slash", () => {
    expect(byName.get("Bambu Support For PA/PET @BBL X1C")).toMatchObject({
      filament_type: "PA",
      filament_vendor: "Bambu Lab",
      filament_colour: "#FFFFFF",
    });
  });

  it("resolves a parent whose file substitutes a hyphen for the name's slash", () => {
    // The two observed sanitizations differ, so both are pinned: a fix that
    // guesses at one substitution scheme passes one of these and fails the
    // other.
    expect(byName.get("Bambu Support For PLA/PETG @BBL X1C")).toMatchObject({
      filament_type: "PLA",
      filament_vendor: "Bambu Lab",
    });
  });

  it("emits filament_vendor resolved from an ancestor", () => {
    expect(byName.get("Bambu ABS @BBL H2S")).toMatchObject({
      filament_type: "ABS",
      filament_colour: "#000000",
      filament_vendor: "Bambu Lab",
    });
  });

  it("emits filament_vendor: null when no profile in the chain states one", () => {
    const entry = byName.get("Generic PLA @BBL H2S");
    expect(entry).toHaveProperty("filament_vendor");
    expect(entry?.filament_vendor).toBeNull();
  });

  it("emits filament_vendor: null for an empty string rather than an empty value", () => {
    expect(byName.get("Empty Vendor @BBL H2S")?.filament_vendor).toBeNull();
  });

  it("emits filament_vendor: null for a non-string value", () => {
    expect(byName.get("Numeric Vendor @BBL H2S")?.filament_vendor).toBeNull();
  });

  it("degrades a cyclic chain to leaf-only metadata without failing the listing", () => {
    expect(byName.get("Cyclic @BBL H2S")).toMatchObject({
      filament_type: "TPU",
      filament_colour: null,
      // NOT "Ghost Vendor": a chain that blew the depth cap resolved nothing.
      filament_vendor: null,
    });
  });

  it("degrades a corrupt ancestor to leaf-only metadata", () => {
    expect(byName.get("Corrupt Ancestor @BBL H2S")).toMatchObject({
      filament_type: "PC",
      filament_vendor: null,
    });
  });

  it("still returns every other preset when some chains fail to resolve", () => {
    expect([...byName.keys()].sort()).toEqual([
      "Bambu ABS @BBL H2S",
      "Bambu Support For PA/PET @BBL X1C",
      "Bambu Support For PLA/PETG @BBL X1C",
      "Corrupt Ancestor @BBL H2S",
      "Cyclic @BBL H2S",
      "Empty Vendor @BBL H2S",
      "Generic PLA @BBL H2S",
      "Numeric Vendor @BBL H2S",
    ]);
  });

  it("warns when an inherits walk degrades to leaf-only metadata", () => {
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some(
        (m) =>
          m.includes("inherits walk failed") && m.includes("Cyclic @BBL H2S"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (m) =>
          m.includes("inherits walk failed") &&
          m.includes("Corrupt Ancestor @BBL H2S"),
      ),
    ).toBe(true);
  });

  it("warns when an individual bundled file cannot be read or parsed", () => {
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some(
        (m) =>
          m.includes("skipping unreadable bundled profile") &&
          m.includes("broken_base.json"),
      ),
    ).toBe(true);
  });

  it("reports how many presets resolved each field once the listing is built", () => {
    // The dangling-parent degrade is silent by design and never throws, so a
    // tier-wide regression to all-null would produce no warning at all. This
    // line is what makes that case diagnosable.
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    const built = lines.find((m) => m.includes("[profiles/bundled] listing built"));
    expect(built).toBeDefined();
    expect(built).toContain("8 filament");
    // ABS + 2 slash-named bases = 3 vendors resolved.
    expect(built).toContain("filament_vendor 3");
  });
});
