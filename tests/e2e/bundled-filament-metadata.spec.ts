/**
 * `GET /profiles/bundled` must report each filament preset's **material**.
 *
 * A concrete BBL filament profile is a thin per-printer delta — `Bambu ABS
 * @BBL H2S` is barely more than `{name, inherits}` — and the material is
 * declared once, further up the `inherits:` chain. Reading only the leaf
 * returned `filament_type: null` for essentially the whole bundled tier, which
 * left Bambuddy's per-slot filament auto-pick with nothing to match on: its
 * type-match score never fired, and an ABS plate pre-picked TPU
 * (bambuddy#47). These cases pin the walk.
 *
 * The fixture mirrors the real BBL shape rather than a flat directory: an
 * abstract root, a material base that names the type, a colour-bearing family
 * base, and the instantiable leaf that states neither.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "./setup";

type Entry = { name: string; filament_type: string | null; filament_colour: string | null };

let root: string;
let previousPath: string | undefined;

function write(dir: string, file: string, json: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(json), "utf8");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-filament-"));
  const filament = path.join(root, "filament");
  fs.mkdirSync(filament);
  fs.mkdirSync(path.join(root, "machine"));
  fs.mkdirSync(path.join(root, "process"));

  write(filament, "fdm_filament_common", {
    name: "fdm_filament_common",
    instantiation: "false",
  });
  // The material lives here — two levels above anything a user can pick.
  write(filament, "fdm_filament_abs", {
    name: "fdm_filament_abs",
    inherits: "fdm_filament_common",
    instantiation: "false",
    filament_type: ["ABS"],
  });
  write(filament, "Bambu ABS @base", {
    name: "Bambu ABS @base",
    inherits: "fdm_filament_abs",
    instantiation: "false",
    default_filament_colour: ["#000000"],
  });
  write(filament, "Bambu ABS @BBL H2S", {
    name: "Bambu ABS @BBL H2S",
    inherits: "Bambu ABS @base",
    instantiation: "true",
  });
  // A leaf that states its own type: the walk must not be needed, and must
  // not overwrite what the leaf says.
  write(filament, "Generic PLA @BBL H2S", {
    name: "Generic PLA @BBL H2S",
    inherits: "fdm_filament_common",
    instantiation: "true",
    filament_type: ["PLA"],
  });
  // OrcaSlicer's runtime spelling of the colour field, on the leaf.
  write(filament, "Generic PETG @BBL H2S", {
    name: "Generic PETG @BBL H2S",
    instantiation: "true",
    filament_type: "PETG",
    filament_colour: "#0000FF",
  });
  // Dangling parent — degrade to what the leaf knows, do not fail the listing.
  write(filament, "Orphan @BBL H2S", {
    name: "Orphan @BBL H2S",
    inherits: "no_such_base",
    instantiation: "true",
  });

  previousPath = process.env.BUNDLED_PROFILES_PATH;
  process.env.BUNDLED_PROFILES_PATH = root;
});

afterAll(() => {
  if (previousPath === undefined) delete process.env.BUNDLED_PROFILES_PATH;
  else process.env.BUNDLED_PROFILES_PATH = previousPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /profiles/bundled — filament metadata", () => {
  let byName: Map<string, Entry>;

  beforeAll(async () => {
    const res = await request.get("/profiles/bundled").expect(200);
    byName = new Map(
      (res.body.filament as Entry[]).map((f) => [f.name, f] as const),
    );
  });

  it("lists only instantiable presets", () => {
    expect([...byName.keys()].sort()).toEqual([
      "Bambu ABS @BBL H2S",
      "Generic PETG @BBL H2S",
      "Generic PLA @BBL H2S",
      "Orphan @BBL H2S",
    ]);
  });

  it("resolves a material declared two levels up the inherits chain", () => {
    expect(byName.get("Bambu ABS @BBL H2S")?.filament_type).toBe("ABS");
  });

  it("resolves an inherited default_filament_colour", () => {
    expect(byName.get("Bambu ABS @BBL H2S")?.filament_colour).toBe("#000000");
  });

  it("keeps a material the leaf states itself", () => {
    expect(byName.get("Generic PLA @BBL H2S")?.filament_type).toBe("PLA");
    // Nothing in that chain states a colour, and inventing one would hand
    // Bambuddy a false exact-match.
    expect(byName.get("Generic PLA @BBL H2S")?.filament_colour).toBeNull();
  });

  it("accepts both colour spellings and scalar as well as array values", () => {
    expect(byName.get("Generic PETG @BBL H2S")).toMatchObject({
      filament_type: "PETG",
      filament_colour: "#0000FF",
    });
  });

  it("degrades to null on a dangling parent instead of failing the listing", () => {
    expect(byName.get("Orphan @BBL H2S")).toMatchObject({
      filament_type: null,
      filament_colour: null,
    });
  });
});
