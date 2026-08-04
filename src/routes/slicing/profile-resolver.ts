import { promises as fs } from "fs";
import * as path from "path";
import { AppError } from "../../middleware/error";

export type ProfileCategory = "machine" | "process" | "filament";

export type ProfileJson = Record<string, unknown> & {
  type?: string;
  name?: string;
  inherits?: string;
};

export interface ResolveOptions {
  bundledProfilesPath: string;
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 16;

// `--load-settings` does not run the GUI's preset-registry resolver.
// Required fields like layer_change_gcode live on parent templates
// (fdm_machine_common etc.) that the CLI will NOT pull in implicitly.
// The resolver therefore walks the chain fully — to the root — and emits
// a flat profile with everything baked in. Dangling inherits values that
// don't map to a bundled file are dropped silently (matches how upstream
// fixtures with stale `fdm_process_bbl_0.20` inherits work today).
export async function resolveProfile(
  profile: ProfileJson,
  category: ProfileCategory,
  options: ResolveOptions,
): Promise<ProfileJson> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let current: ProfileJson = { ...profile };
  stripUserSentinels(current);
  let depth = 0;

  while (
    typeof current.inherits === "string" &&
    current.inherits.length > 0
  ) {
    if (depth >= maxDepth) {
      throw new AppError(
        500,
        "Profile inheritance chain exceeded maximum depth",
        `category=${category} depth=${depth} stopped at inherits=${current.inherits}`,
      );
    }

    const parentName = current.inherits;
    const found = await readParentProfile(
      options.bundledProfilesPath,
      category,
      parentName,
    );
    if (!found) {
      delete current.inherits;
      break;
    }
    const { filePath: parentPath, raw: parentRaw } = found;

    let parent: ProfileJson;
    try {
      parent = JSON.parse(parentRaw) as ProfileJson;
    } catch (err) {
      throw new AppError(
        500,
        `Bundled profile is not valid JSON: "${parentName}"`,
        `category=${category} path=${parentPath} ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    current = mergeProfiles(parent, current);
    depth += 1;
  }

  // After full flattening the output is functionally a system preset, so
  // mark it as one (see normalizeFromField for the casing rationale).
  // materializeProfile also calls this unconditionally so System-tier
  // exports with `inherits: ""` — which never reach this code path — get
  // the same treatment.
  normalizeFromField(current);

  // OrcaSlicer's GUI prefixes user clones of system presets with "# "
  // (e.g. "# Bambu Lab X1 Carbon 0.4 nozzle"). The CLI's compatibility
  // check matches the printer's `name` literally against each profile's
  // `compatible_printers` list, which contains the un-prefixed system
  // names. Strip the prefix so a clone-and-export workflow lines up
  // with the bundled compat lists.
  if (typeof current.name === "string" && current.name.startsWith("# ")) {
    current.name = current.name.slice(2);
  }

  return current;
}

/**
 * Locate and read the bundled file an `inherits:` value names.
 *
 * Two things make this more than a `path.join`:
 *
 * 1. **A profile's declared `name` is not always its file basename.** Some
 *    bundled profiles carry a literal `/` in `name` / `inherits` while the
 *    file on disk sanitizes it — and the two slicers do not agree on the
 *    replacement character:
 *
 *      inherits "Bambu Support For PA/PET @base"  -> "Bambu Support For PA PET @base.json"
 *      inherits "Bambu Support For PLA/PETG @base" -> "Bambu Support For PLA-PETG @base.json"
 *
 *    Deriving the path from the name treats the `/` as a directory
 *    separator, the read ENOENTs, and the whole remaining ancestor chain is
 *    dropped silently — so a preset inheriting such a base sliced
 *    under-specified. Because the sanitization scheme is undocumented and
 *    demonstrably inconsistent, we do not guess at it: we index the
 *    directory by each file's *declared* `name` and look the parent up
 *    there.
 *
 * 2. **`inherits` is attacker-shaped input** on the user-upload paths. A
 *    `..` segment in it reached outside the profiles directory by the same
 *    path-derivation mechanism. The direct lookup is now refused for any
 *    value that is not a plain basename, so nothing outside the category
 *    directory is reachable; the index only ever contains files enumerated
 *    from inside it.
 *
 * Ordering is deliberate: the direct read is tried **first** and the index
 * is built lazily only when it misses. `resolveProfile` runs once per preset
 * in a ~2500-file listing loop and the file basename matches the declared
 * name for the overwhelming majority, so the hot path stays exactly one
 * `readFile` — no directory enumeration, no behavioural change, no
 * regression to the cold-listing latency. The index cost is paid only for
 * the rare slash-named case, and only once per directory.
 *
 * Returns `null` when the parent cannot be located; callers preserve the
 * existing "drop `inherits` and stop walking" behaviour for that case.
 */
async function readParentProfile(
  bundledProfilesPath: string,
  category: ProfileCategory,
  parentName: string,
): Promise<{ filePath: string; raw: string } | null> {
  const dir = path.join(bundledProfilesPath, category);

  if (isPlainBasename(parentName)) {
    const direct = path.join(dir, `${parentName}.json`);
    try {
      return { filePath: direct, raw: await fs.readFile(direct, "utf-8") };
    } catch {
      // Fall through: the name may be declared by a file whose basename was
      // sanitized, or it may simply be dangling.
    }
  }

  const indexed = (await getNameIndex(dir)).get(parentName);
  if (indexed === undefined) return null;
  try {
    return { filePath: indexed, raw: await fs.readFile(indexed, "utf-8") };
  } catch {
    return null;
  }
}

/**
 * True when `name` can safely be used as a file basename inside the category
 * directory — i.e. it cannot escape it. Anything with a path separator (a
 * slash-bearing profile name included) is refused here and resolved through
 * the index instead, which is exactly right: the index cannot name a file
 * the directory listing did not produce.
 */
function isPlainBasename(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    name !== "." &&
    name !== ".." &&
    !path.isAbsolute(name)
  );
}

type NameIndex = Map<string, string>;

// Keyed by the category directory, which already encodes
// (bundledProfilesPath, category). The bundled tree lives in the slicer's
// read-only `resources/profiles/` and only changes when the container image
// is rebuilt, so a process-lifetime cache is safe — and necessary: rebuilding
// per `resolveProfile` call would make the bundled listing O(n^2) in the
// number of profiles.
const nameIndexCache = new Map<string, Promise<NameIndex>>();

/** Test seam: drop the memoised directory indexes. */
export function resetProfileNameIndexCache(): void {
  nameIndexCache.clear();
}

async function getNameIndex(dir: string): Promise<NameIndex> {
  const cached = nameIndexCache.get(dir);
  if (cached) return cached;
  const building = buildNameIndex(dir);
  nameIndexCache.set(dir, building);
  try {
    return await building;
  } catch {
    // A transient FS failure must not poison the cache for the process
    // lifetime; an absent directory simply resolves nothing, as before.
    nameIndexCache.delete(dir);
    return new Map();
  }
}

async function buildNameIndex(dir: string): Promise<NameIndex> {
  const index: NameIndex = new Map();
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    let declared: unknown;
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      declared = (JSON.parse(raw) as ProfileJson).name;
    } catch {
      // Unreadable or malformed bundled file: not indexable. It stays
      // reachable by basename via the direct path, where a JSON error is
      // still reported rather than swallowed.
      continue;
    }
    if (typeof declared !== "string" || declared.length === 0) continue;
    // First writer wins, so a duplicate declared name resolves
    // deterministically (readdir order) rather than depending on call order.
    if (!index.has(declared)) index.set(declared, filePath);
  }
  return index;
}

/**
 * Strip "auto" sentinel values from a user-exported delta in place.
 *
 * OrcaSlicer's GUI lets users leave many numeric fields set to `-1`
 * (or array equivalents) meaning "use the slicer's default". The CLI's
 * range validation rejects these literally — e.g.
 * `prime_tower_brim_width: "-1" not in range [0, ∞]`. By dropping the
 * field from the user's delta, the merged profile picks up whatever
 * value its bundled ancestor sets, or the CLI's compiled-in default.
 *
 * Empty strings get the same treatment because the GUI emits them for
 * fields the user hasn't customized; the CLI rejects them where a
 * concrete value is expected.
 */
function stripUserSentinels(profile: ProfileJson): void {
  for (const k of Object.keys(profile)) {
    const v = profile[k];
    if (v === "-1" || v === "") {
      delete profile[k];
    } else if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((x) => x === "-1" || x === "")
    ) {
      delete profile[k];
    }
  }
}

// BambuStudio's "Export Preset Bundle" omits `type:` on System-tier presets
// (the GUI infers it from the directory the file lived in) and emits
// `inherits: ""` for them, so resolveProfile's inherits walk never runs and
// can't pick up `type` from a parent. The CLI's --load-settings/--load-filaments
// parser then sees a type-less file, logs `operator(): unknown config type
// ... in load-settings`, writes `error_string: "The input preset file is
// invalid and can not be parsed.", return_code: -5` to result.json, and
// exits 0. Stamp the category we already know.
export function ensureProfileType(
  profile: ProfileJson,
  category: ProfileCategory,
): ProfileJson {
  if (typeof profile.type !== "string" || profile.type.length === 0) {
    profile.type = category;
  }
  return profile;
}

// The CLI's compatibility check accepts `from: "system"` (lowercase) as the
// canonical system-tier marker and rejects everything else with
// `from <value> unsupported` (return_code -5, surfaced as the same
// "input preset file is invalid and can not be parsed." rejection).
//
// Two casings appear in real exports:
//   - "User"   — user-cloned presets out of the OrcaSlicer/BambuStudio GUI.
//                After resolveProfile flattens the inherits chain, the
//                output is functionally a system preset and should be
//                marked as such.
//   - "System" — BambuStudio's "Export Preset Bundle" for a System-tier
//                root preset (printer / built-in filament) writes this
//                literally. The GUI accepts it because the GUI's own
//                check is case-insensitive; the CLI's is not.
//
// "Default" and other values are NOT remapped — those are distinct tiers
// the CLI handles, and silently rewriting them would mask a real
// mis-tagged file.
export function normalizeFromField(profile: ProfileJson): ProfileJson {
  if (profile.from === "User" || profile.from === "System") {
    profile.from = "system";
  }
  return profile;
}

export function mergeProfiles(
  parent: ProfileJson,
  child: ProfileJson,
): ProfileJson {
  const merged: ProfileJson = { ...parent, ...child };
  if (typeof parent.inherits === "string" && parent.inherits.length > 0) {
    merged.inherits = parent.inherits;
  } else {
    delete merged.inherits;
  }
  return merged;
}

export function getDefaultBundledProfilesPath(): string | undefined {
  const orcaPath = process.env.BUNDLED_PROFILES_PATH;
  if (orcaPath && orcaPath.length > 0) {
    return orcaPath;
  }
  if (process.env.ORCASLICER_PATH) {
    return path.join(
      path.dirname(process.env.ORCASLICER_PATH),
      "resources",
      "profiles",
      "BBL",
    );
  }
  return undefined;
}
