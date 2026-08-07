import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { uploadJson, uploadBundle } from "../../middleware/upload";
import type { Category } from "../slicing/models";
import {
  saveSetting,
  listSettings,
  getSetting,
  deleteSetting,
} from "./settings.service";
import {
  importBundle,
  listBundles,
  readBundleSummary,
  deleteBundle,
} from "./bundle.service";
import { AppError } from "../../middleware/error";
import {
  getDefaultBundledProfilesPath,
  resolveProfile,
  type ProfileCategory,
} from "../slicing/profile-resolver";

const router = Router();

// In-process cache for the bundled-profiles index. The bundle is read from the
// slicer's read-only `resources/profiles/BBL/` tree, which only changes when
// the container image is rebuilt — a long TTL is safe and avoids re-reading
// hundreds of JSON files on every Slice modal open. `null` = "not yet built".
type BundledFilament = {
  name: string;
  base_id: string | null;
  // Filament-only metadata. Bambuddy uses these to pre-pick a profile per
  // plate slot in the SliceModal multi-color flow.
  //
  // **`filament_type` is almost never on the leaf preset.** A concrete BBL
  // filament profile is a thin per-printer delta — `Bambu PLA Basic @BBL X1C`
  // is little more than `{name, inherits, filament_...tweaks}` — and the
  // material is declared once, further up the `inherits:` chain, on a shared
  // base such as `Bambu PLA Basic @base` or `fdm_filament_pla`. Reading only
  // the leaf therefore returned `null` for essentially the whole tier, which
  // is what made Bambuddy's filament auto-pick material-blind: with no type on
  // any candidate its type-match score never fired and an ABS plate happily
  // pre-picked TPU (bambuddy#47). Both fields are resolved through the
  // inheritance walk.
  //
  // `filament_colour` is genuinely absent from most bundled profiles — colour
  // is a runtime spool attribute, not a profile attribute — and is populated
  // only where the tree really states one, so the consumer can exact-match
  // when possible without being handed a fabricated value.
  filament_type: string | null;
  filament_colour: string | null;
  // Also one hop up the same chain: `filament_vendor` sits on the family
  // base (`Bambu ABS @base` -> `["Bambu Lab"]`) in both slicers, never on
  // the per-printer leaf. It comes free with the walk we already do, and
  // lets Bambuddy group/filter the Standard tier by brand.
  filament_vendor: string | null;
};
type BundledBase = { name: string; base_id: string | null };
type BundledPrinter = BundledBase & {
  // The printer's bed outline, as the polygon the profile tree declares:
  // a list of `"<x>x<y>"` corner points in bed millimetres, e.g.
  // `["0x0","256x0","256x256","0x256"]`. **Not** a width/height pair.
  //
  // Like `filament_type`, it is almost never on the leaf. A concrete BBL
  // machine preset is a per-nozzle delta (`Bambu Lab H2D 0.4 nozzle`), and
  // the bed is declared once on a shared base such as
  // `fdm_bbl_3dp_002_common`. Measured against both bundled trees, the leaf
  // states it for 4/44 presets in OrcaSlicer v2.3.2 and 7/56 in BambuStudio
  // v02.07.01.57 — everything else sits one or two levels up the `inherits:`
  // chain. Reading only the leaf would report `null` for ~90% of the tier.
  //
  // **Emitted raw, deliberately.** Reducing it here to `{width, height}`
  // would silently flatten the shapes that are not axis-aligned rectangles
  // anchored at the origin, and those exist: across OrcaSlicer's full vendor
  // tree, 582 profiles declare a 4-point outline but 8 declare 72 points
  // (round delta beds), 3 declare 6 and 3 declare 239. The consumer knows
  // what it needs — a bounding box, a render outline — and can decide.
  //
  // `null` means the whole chain stated nothing usable. It is NOT "a bed of
  // size zero", and consumers must keep the two apart.
  printable_area: string[] | null;
};
type BundledIndex = {
  printer: BundledPrinter[];
  process: BundledBase[];
  filament: BundledFilament[];
};
let bundledIndexCache: BundledIndex | null = null;
let bundledIndexCachedAt = 0;
const BUNDLED_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

router.get("/bundled", async (_req, res) => {
  // Bambuddy SliceModal calls this to populate the "Standard" tier of profile
  // dropdowns. Empty arrays are returned (200, not 503) when the bundled tree
  // can't be located — callers degrade to "no standard tier" without surfacing
  // a confusing error.
  const bundledPath = getDefaultBundledProfilesPath();
  if (!bundledPath) {
    res.status(200).json({ printer: [], process: [], filament: [] });
    return;
  }

  const now = Date.now();
  if (bundledIndexCache && now - bundledIndexCachedAt < BUNDLED_CACHE_TTL_MS) {
    res.status(200).json(bundledIndexCache);
    return;
  }

  const result: BundledIndex = {
    printer: (await readBundledDir(
      path.join(bundledPath, "machine"),
      "machine",
      bundledPath,
    )) as BundledPrinter[],
    process: await readBundledDir(
      path.join(bundledPath, "process"),
      "process",
      null,
    ),
    filament: (await readBundledDir(
      path.join(bundledPath, "filament"),
      "filament",
      bundledPath,
    )) as BundledFilament[],
  };
  // Resolution counts, once per cache fill. The per-preset degrade paths warn
  // when the walk *throws*, but the commonest silent failure mode — a
  // dangling `inherits` that resolves to nothing, which by design neither
  // throws nor warns — shows up only as fields quietly going `null` across
  // the tier. This line is what makes that regression self-diagnosing.
  const resolved = (key: keyof BundledFilament) =>
    result.filament.filter((f) => f[key] !== null).length;
  const beds = result.printer.filter((p) => p.printable_area !== null).length;
  console.info(
    `[profiles/bundled] listing built: ${result.printer.length} printer, ${result.process.length} process, ${result.filament.length} filament ` +
      `(printable_area ${beds}, filament_type ${resolved("filament_type")}, filament_vendor ${resolved("filament_vendor")}, filament_colour ${resolved("filament_colour")} resolved)`,
  );

  bundledIndexCache = result;
  bundledIndexCachedAt = now;
  res.status(200).json(result);
});

/**
 * List one bundled category.
 *
 * `bundledProfilesPath` is non-null for the categories that carry resolved
 * metadata — filament (`filament_type` / `filament_colour` / `filament_vendor`)
 * and machine (`printable_area`) — and is the root the `inherits:` walk
 * resolves parents against. The process listing needs no metadata, so it never
 * pays for the walk.
 */
async function readBundledDir(
  dir: string,
  category: ProfileCategory,
  bundledProfilesPath: string | null,
): Promise<(BundledBase | BundledPrinter | BundledFilament)[]> {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: (BundledBase | BundledPrinter | BundledFilament)[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const json = JSON.parse(raw) as RawFilamentFields &
        RawPrinterFields & {
          instantiation?: string;
        };
      // Bundled profiles ship a mix of concrete presets and abstract bases
      // (e.g. `fdm_filament_pla`). Skip the latter so the slicer modal only
      // offers things a user can actually pick. `instantiation:"true"` is the
      // BBL convention for "this is a leaf preset".
      if (json.instantiation && json.instantiation !== "true") continue;
      if (!json.name) continue;
      const base: BundledBase = { name: json.name, base_id: json.inherits ?? null };
      if (bundledProfilesPath && category === "filament") {
        out.push({
          ...base,
          ...(await filamentMetadata(json, bundledProfilesPath)),
        });
      } else if (bundledProfilesPath && category === "machine") {
        out.push({
          ...base,
          ...(await printerMetadata(json, bundledProfilesPath)),
        });
      } else {
        out.push(base);
      }
    } catch (err) {
      // Corrupted / unreadable individual file — skip without breaking the
      // rest of the listing, but say so: a systematic read failure would
      // otherwise present as a silently empty (or short) listing.
      console.warn(
        `[profiles/bundled] skipping unreadable bundled profile ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
  }
  // Stable alphabetical order by name so the dropdown is predictable.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

type RawFilamentFields = {
  name?: string;
  inherits?: string;
  filament_type?: string | string[];
  filament_colour?: string | string[];
  default_filament_colour?: string | string[];
  // Only one spelling exists for this one — unlike colour, there is no
  // `default_filament_vendor` in either bundled tree. Do not invent one.
  filament_vendor?: string | string[];
};

/**
 * `filament_type` / `filament_colour` for one leaf preset, following
 * `inherits:` when the leaf does not state them itself.
 *
 * The walk is `resolveProfile` — the same flattener `/resolved-process` and
 * the slice path already use — rather than a second, subtly different one. It
 * only runs when the leaf is missing something, which on the BBL tree is the
 * common case for `filament_type` and the near-universal case for colour, but
 * the whole listing sits behind a 1-hour cache either way.
 *
 * A profile whose chain cannot be resolved (dangling parent, malformed
 * ancestor, cyclic inherits hitting the depth cap) degrades to whatever the
 * leaf itself stated. Reporting `null` for one preset costs Bambuddy a match;
 * failing the request would cost it the entire Standard tier.
 */
async function filamentMetadata(
  leaf: RawFilamentFields,
  bundledProfilesPath: string,
): Promise<{
  filament_type: string | null;
  filament_colour: string | null;
  filament_vendor: string | null;
}> {
  let fields: RawFilamentFields = leaf;
  const needsWalk =
    typeof leaf.inherits === "string" &&
    leaf.inherits.length > 0 &&
    (firstScalar(leaf.filament_type) === null ||
      colourOf(leaf) === null ||
      firstScalar(leaf.filament_vendor) === null);
  if (needsWalk) {
    try {
      fields = (await resolveProfile({ ...leaf }, "filament", {
        bundledProfilesPath,
      })) as RawFilamentFields;
    } catch (err) {
      // Degrading to leaf-only metadata is deliberate (one preset loses a
      // match; failing would cost the caller the whole Standard tier) — but
      // it must not be *silent*. If resolution ever breaks systematically
      // this endpoint would otherwise go back to answering all-`null` with
      // no trace of why.
      console.warn(
        `[profiles/bundled] inherits walk failed for filament preset "${leaf.name ?? "<unnamed>"}" (inherits="${leaf.inherits}"); falling back to leaf-only metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields = leaf;
    }
  }
  return {
    filament_type: firstScalar(fields.filament_type),
    filament_colour: colourOf(fields),
    filament_vendor: firstScalar(fields.filament_vendor),
  };
}

/**
 * The two spellings the bundled trees actually use.
 *
 * `filament_colour` is the runtime/per-spool field and is what a user-exported
 * preset carries; the bundled BBL profiles that state a colour at all use
 * `default_filament_colour` (which is also the key Bambuddy's own local-preset
 * importer reads). The two slicers do not agree on which appears where, so
 * both are accepted, in that order of specificity.
 */
function colourOf(fields: RawFilamentFields): string | null {
  return (
    firstScalar(fields.filament_colour) ??
    firstScalar(fields.default_filament_colour)
  );
}

function firstScalar(value: string | string[] | undefined): string | null {
  // OrcaSlicer stores per-extruder fields like `filament_type` as arrays
  // (e.g. `["PLA"]` for single-extruder, `["PLA", "PETG"]` for bi-material).
  // For pre-pick matching the first slot is what matters; the caller already
  // knows which slot it's matching to and a per-slot value isn't meaningful
  // on a bundled profile that hasn't been bound to a specific extruder yet.
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.length > 0 ? first : null;
  }
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

type RawPrinterFields = {
  name?: string;
  inherits?: string;
  printable_area?: unknown;
};

/**
 * `printable_area` for one bundled machine preset, following `inherits:` when
 * the leaf does not state it.
 *
 * Same walk (`resolveProfile`) and the same degrade contract as
 * `filamentMetadata` — the machinery is shared on purpose; a second, subtly
 * different walker is how the leaf-only bug got shipped twice.
 *
 * Verified against both bundled trees at the versions the sidecar images
 * carry, `SoftFever/OrcaSlicer@v2.3.2` and `bambulab/BambuStudio@v02.07.01.57`:
 * the key is spelled `printable_area` in both, carries the same
 * `["<x>x<y>", ...]` corner-point shape in both, and resolves for **every**
 * instantiable `type: "machine"` preset in both (44/44 and 56/56) — but only
 * through the walk. The two trees genuinely disagree on ~330 setting keys, so
 * that agreement was measured rather than assumed.
 *
 * The listing also contains `type: "machine_model"` catalogue entries
 * ("Bambu Lab H2D" with no nozzle suffix). Those describe a printer FAMILY,
 * not a slicing preset, and declare no bed at any point in their chain. They
 * report `null`, which is the honest answer: there is no bed to report, and
 * inventing the 0.4-nozzle variant's would be a fabricated value.
 */
async function printerMetadata(
  leaf: RawPrinterFields,
  bundledProfilesPath: string,
): Promise<{ printable_area: string[] | null }> {
  let fields: RawPrinterFields = leaf;
  const needsWalk =
    typeof leaf.inherits === "string" &&
    leaf.inherits.length > 0 &&
    pointListOf(leaf.printable_area) === null;
  if (needsWalk) {
    try {
      fields = (await resolveProfile({ ...leaf }, "machine", {
        bundledProfilesPath,
      })) as RawPrinterFields;
    } catch (err) {
      // Same trade as the filament walk: one printer loses its bed rather
      // than the caller losing the entire Standard tier — but say so. A
      // systematic resolution failure would otherwise present as every
      // printer quietly reporting `null`, which is exactly the shape of a
      // deployment still running an old sidecar, and the two would be
      // indistinguishable from the outside.
      console.warn(
        `[profiles/bundled] inherits walk failed for printer preset "${leaf.name ?? "<unnamed>"}" (inherits="${leaf.inherits}"); falling back to leaf-only metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields = leaf;
    }
  }
  return { printable_area: pointListOf(fields.printable_area) };
}

/**
 * Normalise a declared bed outline to a list of corner-point strings.
 *
 * **Container shape only — never geometry.** Every point the profile declares
 * survives, in order. What is normalised is the packaging, which the bundled
 * trees are not consistent about:
 *
 *   - Almost every profile writes a JSON array of `"<x>x<y>"` strings.
 *   - At least one writes the whole polygon as a single comma-joined string
 *     (`"0x0,400x0,400x400,0x400"` — Creality Ender-5 Max, OrcaSlicer's
 *     Creality vendor tree). Left alone, that reaches the consumer as an
 *     un-splittable scalar.
 *   - At least one has a stray trailing space inside a point
 *     (`"0x256 "` — `Bambu Lab X2D 0.4 nozzle`, BambuStudio). Left alone, a
 *     consumer parsing `parseFloat` per axis mostly survives it and a
 *     consumer doing strict parsing does not.
 *
 * Fewer than three usable points is not a polygon, so it degrades to `null`
 * (with a warning) rather than reaching the consumer as a bed whose bounding
 * box happens to be zero-sized. `null` must keep meaning "absent", never
 * "0 × 0".
 */
function pointListOf(value: unknown): string[] | null {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (raw === null) return null;
  const points: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (trimmed.length > 0) points.push(trimmed);
  }
  if (points.length === 0) return null;
  if (points.length < 3) {
    console.warn(
      `[profiles/bundled] ignoring printable_area with ${points.length} usable point(s) — a bed outline needs at least 3: ${JSON.stringify(value)}`,
    );
    return null;
  }
  return points;
}

// Bundle routes are defined before /:category so the literal "bundle" /
// "bundles" path segments don't get matched as a category by the more
// generic handlers below (validateCategory would reject them).
//
// POST /profiles/bundle
//   Upload a BambuStudio "Printer Preset Bundle" (.bbscfg). Idempotent —
//   re-uploading the same file yields the same bundle id and re-uses the
//   existing extracted directory.
router.post("/bundle", uploadBundle.single("file"), async (req, res) => {
  if (!req.file) {
    throw new AppError(400, "Bundle file is required");
  }
  const summary = await importBundle(req.file.buffer);
  res.status(201).json(summary);
});

// GET /profiles/bundles
//   List every bundle stored in DATA_PATH/bundles. Each summary names the
//   inner printer / process / filament presets a slice request can pick
//   from, so the consumer doesn't need a second round-trip per bundle to
//   build a Slice modal.
router.get("/bundles", async (_req, res) => {
  const bundles = await listBundles();
  res.status(200).json(bundles);
});

// GET /profiles/bundles/:id
//   Single-bundle summary (same shape as the list entry). Useful when a
//   client persists the id and wants to re-confirm the bundle still exists
//   and which presets it contains before showing slice options.
router.get("/bundles/:id", async (req, res) => {
  const summary = await readBundleSummary(req.params.id);
  res.status(200).json(summary);
});

// DELETE /profiles/bundles/:id
//   Remove a bundle and its extracted preset files. Slicing requests
//   referencing this id will fail with 404 afterwards.
router.delete("/bundles/:id", async (req, res) => {
  await deleteBundle(req.params.id);
  res.status(204).send();
});

router.post("/:category", uploadJson.single("file"), async (req, res) => {
  const name = req.body.name;

  validateName(name);

  if (!req.file) {
    throw new AppError(400, "File is required");
  }

  validateCategory(req.params.category as string);

  const content = JSON.parse(req.file.buffer.toString("utf8"));
  await saveSetting(req.params.category as Category, name, content);
  res.status(201).json({ name });
});

router.get("/:category", async (req, res) => {
  validateCategory(req.params.category);

  const settings = await listSettings(req.params.category as Category);
  res.status(200).json(settings);
});

router.get("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  const setting = await getSetting(
    req.params.category as Category,
    req.params.name,
  );
  res.status(200).json(setting);
});

router.delete("/:category/:name", async (req, res) => {
  validateCategory(req.params.category);
  validateName(req.params.name);

  await deleteSetting(req.params.category as Category, req.params.name);
  res.status(204).send();
});

function validateCategory(category: string) {
  if (!category || !["printers", "presets", "filaments"].includes(category)) {
    throw new AppError(400, "Invalid or missing category");
  }
}

function validateName(name: string) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new AppError(400, "Name cannot be empty");
  }
  if (!/^[a-zA-Z0-9]+$/.test(name)) {
    throw new AppError(400, "Name must only contain letters and numbers");
  }
}

export default router;
