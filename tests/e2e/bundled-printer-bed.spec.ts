/**
 * `GET /profiles/bundled` must report each printer preset's **bed outline**.
 *
 * A concrete BBL machine profile is a thin per-nozzle delta — `Bambu Lab H2D
 * 0.4 nozzle` is barely more than `{name, inherits, nozzle_diameter}` — and
 * the bed is declared once, further up the `inherits:` chain, on a shared base
 * such as `fdm_bbl_3dp_002_common`. Measured against the real bundled trees,
 * the leaf states `printable_area` for 4/44 presets in OrcaSlicer v2.3.2 and
 * 7/56 in BambuStudio v02.07.01.57; through the walk it resolves for 44/44 and
 * 56/56. Reading only the leaf would report `null` for ~90% of the tier, which
 * is exactly the failure mode `filament_type` had (bambuddy#47) and which cost
 * a ticket to localize.
 *
 * The fixture mirrors the real machine tree rather than a flat directory: an
 * abstract root, a family base that declares the bed, an intermediate, and the
 * instantiable leaf that declares nothing.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  type MockInstance,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "./setup";

type Entry = { name: string; base_id: string | null; printable_area: string[] | null };

let root: string;
let previousPath: string | undefined;

function write(dir: string, file: string, json: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(json), "utf8");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-printer-bed-"));
  const machine = path.join(root, "machine");
  fs.mkdirSync(machine);
  fs.mkdirSync(path.join(root, "filament"));
  fs.mkdirSync(path.join(root, "process"));

  // ---- the ordinary case: bed two levels above the instantiable leaf ------
  write(machine, "fdm_machine_common", {
    name: "fdm_machine_common",
    type: "machine",
    instantiation: "false",
  });
  write(machine, "fdm_bbl_3dp_002_common", {
    name: "fdm_bbl_3dp_002_common",
    type: "machine",
    inherits: "fdm_machine_common",
    instantiation: "false",
    printable_area: ["0x0", "350x0", "350x320", "0x320"],
  });
  write(machine, "Bambu Lab H2D nozzle base", {
    name: "Bambu Lab H2D nozzle base",
    type: "machine",
    inherits: "fdm_bbl_3dp_002_common",
    instantiation: "false",
  });
  write(machine, "Bambu Lab H2D 0.4 nozzle", {
    name: "Bambu Lab H2D 0.4 nozzle",
    type: "machine",
    inherits: "Bambu Lab H2D nozzle base",
    instantiation: "true",
  });

  // ---- a leaf that states its own bed: the walk must not overwrite it -----
  write(machine, "Bambu Lab X1 Carbon 0.4 nozzle", {
    name: "Bambu Lab X1 Carbon 0.4 nozzle",
    type: "machine",
    inherits: "fdm_bbl_3dp_002_common",
    instantiation: "true",
    printable_area: ["0x0", "256x0", "256x256", "0x256"],
  });

  // ---- packaging warts that exist verbatim in the bundled trees -----------
  // BambuStudio v02.07.01.57 ships this one with a trailing space inside the
  // last point.
  write(machine, "Bambu Lab X2D 0.4 nozzle", {
    name: "Bambu Lab X2D 0.4 nozzle",
    type: "machine",
    instantiation: "true",
    printable_area: ["0x0", "256x0", "256x256", "0x256 "],
  });
  // OrcaSlicer's Creality tree writes the whole polygon as one comma-joined
  // string instead of an array.
  write(machine, "Creality Ender-5 Max 0.4 nozzle", {
    name: "Creality Ender-5 Max 0.4 nozzle",
    type: "machine",
    instantiation: "true",
    printable_area: "0x0,400x0,400x400,0x400",
  });

  // ---- a bed that is not an origin-anchored rectangle ---------------------
  // 8 profiles in OrcaSlicer's vendor tree declare 72-point round beds and 3
  // declare 6-point ones. Reducing to {width,height} here would throw the
  // shape away; the contract is that every declared point survives, in order.
  write(machine, "Hexagonal 0.4 nozzle", {
    name: "Hexagonal 0.4 nozzle",
    type: "machine",
    instantiation: "true",
    printable_area: ["50x0", "150x0", "200x87", "150x173", "50x173", "0x87"],
  });

  // ---- a parent whose file basename sanitizes a slash in its name ---------
  // Printers go through the same declared-name index the filament walk uses,
  // so this resolves for free — pinned so a regression there is caught on
  // both categories rather than only on filament.
  fs.writeFileSync(
    path.join(machine, "Bambu Lab H2D-Pro @base.json"),
    JSON.stringify({
      name: "Bambu Lab H2D/Pro @base",
      type: "machine",
      instantiation: "false",
      printable_area: ["0x0", "350x0", "350x320", "0x320"],
    }),
    "utf8",
  );
  write(machine, "Bambu Lab H2D Pro 0.4 nozzle", {
    name: "Bambu Lab H2D Pro 0.4 nozzle",
    type: "machine",
    inherits: "Bambu Lab H2D/Pro @base",
    instantiation: "true",
  });

  // ---- entries that legitimately have no bed -----------------------------
  // A `machine_model` catalogue entry: a printer FAMILY, not a slicing preset.
  // It carries no `instantiation` key, so the listing includes it today; it
  // declares no bed anywhere and must report null rather than borrow one.
  write(machine, "Bambu Lab H2D", {
    name: "Bambu Lab H2D",
    type: "machine_model",
    nozzle_diameter: "0.4;0.2;0.6;0.8",
    family: "BBL-3DP",
  });

  // ---- degrade paths ------------------------------------------------------
  write(machine, "Orphan 0.4 nozzle", {
    name: "Orphan 0.4 nozzle",
    type: "machine",
    inherits: "no_such_machine_base",
    instantiation: "true",
  });
  write(machine, "cycle_a", {
    name: "cycle_a",
    type: "machine",
    inherits: "cycle_b",
    instantiation: "false",
    printable_area: ["0x0", "999x0", "999x999", "0x999"],
  });
  write(machine, "cycle_b", {
    name: "cycle_b",
    type: "machine",
    inherits: "cycle_a",
    instantiation: "false",
  });
  write(machine, "Cyclic 0.4 nozzle", {
    name: "Cyclic 0.4 nozzle",
    type: "machine",
    inherits: "cycle_b",
    instantiation: "true",
  });
  fs.writeFileSync(
    path.join(machine, "broken_machine_base.json"),
    "{ not json",
    "utf8",
  );
  write(machine, "Corrupt Ancestor 0.4 nozzle", {
    name: "Corrupt Ancestor 0.4 nozzle",
    type: "machine",
    inherits: "broken_machine_base",
    instantiation: "true",
  });
  // Two points is not a polygon. It must degrade to null, not to a bed whose
  // bounding box happens to be 10 x 0 — `null` has to keep meaning "absent".
  write(machine, "Degenerate 0.4 nozzle", {
    name: "Degenerate 0.4 nozzle",
    type: "machine",
    instantiation: "true",
    printable_area: ["0x0", "10x0"],
  });

  previousPath = process.env.BUNDLED_PROFILES_PATH;
  process.env.BUNDLED_PROFILES_PATH = root;
});

afterAll(() => {
  if (previousPath === undefined) delete process.env.BUNDLED_PROFILES_PATH;
  else process.env.BUNDLED_PROFILES_PATH = previousPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /profiles/bundled — printer printable_area", () => {
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
      (res.body.printer as Entry[]).map((p) => [p.name, p] as const),
    );
  });

  afterAll(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("resolves a bed declared two levels up the inherits chain", () => {
    expect(byName.get("Bambu Lab H2D 0.4 nozzle")?.printable_area).toEqual([
      "0x0",
      "350x0",
      "350x320",
      "0x320",
    ]);
  });

  it("keeps a bed the leaf states itself", () => {
    expect(
      byName.get("Bambu Lab X1 Carbon 0.4 nozzle")?.printable_area,
    ).toEqual(["0x0", "256x0", "256x256", "0x256"]);
  });

  it("resolves through a parent whose file basename sanitizes a slash", () => {
    expect(byName.get("Bambu Lab H2D Pro 0.4 nozzle")?.printable_area).toEqual([
      "0x0",
      "350x0",
      "350x320",
      "0x320",
    ]);
  });

  it("emits the polygon raw rather than reducing it to width x height", () => {
    // Six points in, six points out, in order. A {width,height} reduction
    // would report 200 x 173 and silently turn a hexagon into a rectangle.
    expect(byName.get("Hexagonal 0.4 nozzle")?.printable_area).toEqual([
      "50x0",
      "150x0",
      "200x87",
      "150x173",
      "50x173",
      "0x87",
    ]);
  });

  it("trims stray whitespace inside a declared point", () => {
    expect(byName.get("Bambu Lab X2D 0.4 nozzle")?.printable_area).toEqual([
      "0x0",
      "256x0",
      "256x256",
      "0x256",
    ]);
  });

  it("splits a polygon written as one comma-joined string", () => {
    expect(
      byName.get("Creality Ender-5 Max 0.4 nozzle")?.printable_area,
    ).toEqual(["0x0", "400x0", "400x400", "0x400"]);
  });

  it("reports null for a machine_model catalogue entry", () => {
    const entry = byName.get("Bambu Lab H2D");
    expect(entry).toHaveProperty("printable_area");
    expect(entry?.printable_area).toBeNull();
  });

  it("degrades to null on a dangling parent instead of failing the listing", () => {
    expect(byName.get("Orphan 0.4 nozzle")?.printable_area).toBeNull();
  });

  it("degrades a cyclic chain to null rather than a bed found inside the cycle", () => {
    // cycle_a states a 999 x 999 bed. A walk that blew the depth cap resolved
    // nothing, so reporting that value would be a fabricated answer.
    expect(byName.get("Cyclic 0.4 nozzle")?.printable_area).toBeNull();
  });

  it("degrades a corrupt ancestor to null", () => {
    expect(byName.get("Corrupt Ancestor 0.4 nozzle")?.printable_area).toBeNull();
  });

  it("degrades a polygon with fewer than three points to null", () => {
    expect(byName.get("Degenerate 0.4 nozzle")?.printable_area).toBeNull();
  });

  it("still returns every printer preset when some chains fail to resolve", () => {
    expect([...byName.keys()].sort()).toEqual([
      "Bambu Lab H2D",
      "Bambu Lab H2D 0.4 nozzle",
      "Bambu Lab H2D Pro 0.4 nozzle",
      "Bambu Lab X1 Carbon 0.4 nozzle",
      "Bambu Lab X2D 0.4 nozzle",
      "Corrupt Ancestor 0.4 nozzle",
      "Creality Ender-5 Max 0.4 nozzle",
      "Cyclic 0.4 nozzle",
      "Degenerate 0.4 nozzle",
      "Hexagonal 0.4 nozzle",
      "Orphan 0.4 nozzle",
    ]);
  });

  it("warns when a printer's inherits walk degrades to leaf-only metadata", () => {
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some(
        (m) =>
          m.includes("inherits walk failed for printer preset") &&
          m.includes("Cyclic 0.4 nozzle"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (m) =>
          m.includes("inherits walk failed for printer preset") &&
          m.includes("Corrupt Ancestor 0.4 nozzle"),
      ),
    ).toBe(true);
  });

  it("warns when a declared printable_area is too short to be a polygon", () => {
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some((m) =>
        m.includes("ignoring printable_area with 2 usable point(s)"),
      ),
    ).toBe(true);
  });

  it("reports how many printers resolved a bed once the listing is built", () => {
    // The dangling-parent degrade is silent by design and never throws, so a
    // tier-wide regression to all-null would produce no warning at all. This
    // line is what makes that case diagnosable — and it is the number that
    // distinguishes "old sidecar" from "resolver broken" in a deployment.
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    const built = lines.find((m) =>
      m.includes("[profiles/bundled] listing built"),
    );
    expect(built).toBeDefined();
    expect(built).toContain("11 printer");
    expect(built).toContain("printable_area 6");
  });
});
