/**
 * Friendly hostname generation: `adjective-noun-suffix`, e.g. `amber-otter-k7`.
 *
 * Hostnames are globally unique across live pages and tombstones and are never
 * reused. Word lists and suffix size are deliberately small MVP choices; the
 * suffix (letter + alphanumeric) gives ~3.8M combinations overall.
 */

const ADJECTIVES = [
  "amber", "arctic", "autumn", "azure", "bold", "brave", "bright", "brisk",
  "calm", "cedar", "citrus", "clever", "cobalt", "copper", "coral", "cosmic",
  "crimson", "crisp", "dapper", "dawn", "deep", "dusty", "eager", "early",
  "ember", "fable", "fair", "fern", "floral", "gentle", "gilded", "glad",
  "golden", "green", "hazel", "humble", "indigo", "ivory", "jade", "jolly",
  "keen", "kind", "lively", "lunar", "mellow", "mint", "misty", "noble",
  "north", "olive", "opal", "pale", "plum", "polar", "proud", "quiet",
  "rapid", "rosy", "royal", "rustic", "sable", "sage", "scarlet", "silver",
  "sleek", "snowy", "solar", "spry", "stellar", "still", "summer", "sunny",
  "swift", "teal", "tidal", "topaz", "tranquil", "umber", "velvet", "vivid",
  "warm", "wild", "winter", "zesty",
] as const;

const NOUNS = [
  "alder", "aspen", "badger", "beacon", "birch", "bison", "bluff", "brook",
  "canyon", "cliff", "comet", "condor", "coral", "crane", "creek", "delta",
  "dune", "eagle", "ember", "falcon", "fjord", "gale", "glade", "grove",
  "harbor", "hawk", "heron", "iris", "island", "jetty", "kestrel", "lagoon",
  "lark", "lynx", "maple", "marmot", "meadow", "mesa", "moose", "moth",
  "oak", "orbit", "orca", "osprey", "otter", "owl", "pebble", "pine",
  "plover", "prairie", "quartz", "raven", "reef", "ridge", "river", "robin",
  "sparrow", "spruce", "summit", "swan", "thicket", "tide", "trail", "tundra",
  "valley", "vista", "walrus", "willow", "wren", "zephyr",
] as const;

const SUFFIX_FIRST = "abcdefghijklmnopqrstuvwxyz";
const SUFFIX_SECOND = "abcdefghijklmnopqrstuvwxyz0123456789";

export type Rng = () => number;

function pick<T>(items: readonly T[], rng: Rng): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

/** Produce one hostname candidate. Pure given the rng. */
export function candidateHostname(rng: Rng = Math.random): string {
  const adjective = pick(ADJECTIVES, rng);
  const noun = pick(NOUNS, rng);
  const suffix = pick([...SUFFIX_FIRST], rng) + pick([...SUFFIX_SECOND], rng);
  return `${adjective}-${noun}-${suffix}`;
}

export const HOSTNAME_PATTERN = /^[a-z]+-[a-z]+-[a-z][a-z0-9]$/;

/**
 * Generate a hostname that is unique across live pages and tombstones.
 * Retries on collision; collisions are rare at MVP scale.
 */
export async function generateUniqueHostname(
  db: D1Database,
  options: { rng?: Rng; maxAttempts?: number } = {},
): Promise<string> {
  const { rng = Math.random, maxAttempts = 10 } = options;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const hostname = candidateHostname(rng);
    const taken = await db
      .prepare(
        `SELECT 1 AS x FROM pages WHERE hostname = ?1
         UNION ALL
         SELECT 1 AS x FROM tombstones WHERE hostname = ?1
         LIMIT 1`,
      )
      .bind(hostname)
      .first();
    if (taken === null) {
      return hostname;
    }
  }
  throw new Error("Could not generate a unique hostname");
}
