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
type BundledIndex = {
  printer: { name: string; base_id: string | null }[];
  process: { name: string; base_id: string | null }[];
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
    printer: await readBundledDir(path.join(bundledPath, "machine"), null),
    process: await readBundledDir(path.join(bundledPath, "process"), null),
    filament: (await readBundledDir(
      path.join(bundledPath, "filament"),
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
  console.info(
    `[profiles/bundled] listing built: ${result.printer.length} printer, ${result.process.length} process, ${result.filament.length} filament ` +
      `(filament_type ${resolved("filament_type")}, filament_vendor ${resolved("filament_vendor")}, filament_colour ${resolved("filament_colour")} resolved)`,
  );

  bundledIndexCache = result;
  bundledIndexCachedAt = now;
  res.status(200).json(result);
});

/**
 * List one bundled category.
 *
 * `bundledProfilesPath` is non-null only for the filament directory, where it
 * is the root the `inherits:` walk resolves parents against. Printer and
 * process listings need no metadata, so they never pay for the walk.
 */
async function readBundledDir(
  dir: string,
  bundledProfilesPath: string | null,
): Promise<({ name: string; base_id: string | null } | BundledFilament)[]> {
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: ({ name: string; base_id: string | null } | BundledFilament)[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const json = JSON.parse(raw) as RawFilamentFields & {
        instantiation?: string;
      };
      // Bundled profiles ship a mix of concrete presets and abstract bases
      // (e.g. `fdm_filament_pla`). Skip the latter so the slicer modal only
      // offers things a user can actually pick. `instantiation:"true"` is the
      // BBL convention for "this is a leaf preset".
      if (json.instantiation && json.instantiation !== "true") continue;
      if (!json.name) continue;
      const base = { name: json.name, base_id: json.inherits ?? null };
      if (bundledProfilesPath) {
        out.push({
          ...base,
          ...(await filamentMetadata(json, bundledProfilesPath)),
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
