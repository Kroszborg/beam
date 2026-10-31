/**
 * Short transfer codes: `<nameplate>-<word>-<word>`, e.g. `42-tiger-ocean`.
 *
 * The nameplate is a number the server maps to the room. The two words come
 * from a fixed list of 256, so they add only 16 bits — far too few for a key,
 * which is why the whole code is only ever used as a PAKE password (see
 * crypto/pake.ts). An attacker learns nothing offline and gets one online
 * guess per attempt; the sender disables the code after MAX_CODE_ATTEMPTS
 * failures, so a guess succeeds with odds below 1 in 20 000 per code.
 */

export const MAX_CODE_ATTEMPTS = 3;

/** 256 short, common words with distinct spellings (no homophones). */
export const WORDS: readonly string[] = [
  'acid', 'acorn', 'actor', 'adobe', 'agent', 'album', 'alien', 'alpha', 'amber', 'angle', 'apple',
  'apron', 'arena', 'arrow', 'atlas', 'attic', 'badge', 'bagel', 'baker', 'banjo', 'basil',
  'beach', 'beard', 'bench', 'berry', 'bison', 'blade', 'blaze', 'blimp', 'bloom', 'board',
  'bongo', 'bonus', 'boots', 'brain', 'brick', 'bride', 'broom', 'brush', 'bucket', 'buggy',
  'bunny', 'cabin', 'cable', 'cactus', 'camel', 'candy', 'canoe', 'canyon', 'cargo', 'carpet',
  'castle', 'cedar', 'chalk', 'charm', 'cheese', 'cherry', 'chess', 'chief', 'cider', 'cinema',
  'circus', 'clock', 'cloud', 'clover', 'coach', 'cobra', 'cocoa', 'comet', 'coral', 'cotton',
  'couch', 'crane', 'crayon', 'crown', 'cube', 'daisy', 'dance', 'delta', 'denim', 'desert',
  'dingo', 'disco', 'dolphin', 'donkey', 'dragon', 'drum', 'eagle', 'easel', 'echo', 'elbow',
  'elder', 'ember', 'emerald', 'engine', 'falcon', 'fable', 'feather', 'fern', 'ferry', 'fiddle',
  'finch', 'flame', 'flask', 'flute', 'forest', 'fossil', 'fox', 'frost', 'galaxy', 'garden',
  'gecko', 'ghost', 'giant', 'ginger', 'giraffe', 'globe', 'goose', 'gravel', 'guitar', 'hammer',
  'harbor', 'harp', 'hazel', 'helmet', 'hippo', 'honey', 'hornet', 'hotel', 'husky', 'igloo',
  'island', 'ivory', 'jacket', 'jaguar', 'jelly', 'jewel', 'jigsaw', 'jungle', 'kayak', 'kettle',
  'kiwi', 'koala', 'ladder', 'lagoon', 'lantern', 'lava', 'lemon', 'lily', 'lizard', 'llama',
  'lobster', 'locket', 'lotus', 'magnet', 'mango', 'maple', 'marble', 'meadow', 'melon', 'meteor',
  'mint', 'mitten', 'monkey', 'moose', 'muffin', 'museum', 'nectar', 'needle', 'nickel', 'noodle',
  'nugget', 'oasis', 'ocean', 'olive', 'onion', 'opal', 'orbit', 'orchid', 'otter', 'oyster',
  'paddle', 'palace', 'panda', 'parrot', 'pastel', 'peach', 'pebble', 'pepper', 'piano', 'pickle',
  'pigeon', 'pillow', 'pirate', 'pixel', 'planet', 'plum', 'pocket', 'poodle', 'poppy', 'prism',
  'pumpkin', 'puzzle', 'quartz', 'rabbit', 'radar', 'radish', 'raven', 'reef', 'ribbon', 'robot',
  'rocket', 'rodeo', 'saddle', 'salmon', 'sandal', 'satin', 'scarf', 'shark', 'shovel', 'silver',
  'sketch', 'sloth', 'snail', 'spider', 'spruce', 'squid', 'statue', 'summit', 'sunset', 'swan',
  'tablet', 'taco', 'tango', 'temple', 'thunder', 'tiger', 'timber', 'toast', 'tomato', 'topaz',
  'tractor', 'tulip', 'tunnel', 'turtle', 'unicorn', 'valley', 'velvet', 'violin', 'volcano',
  'waffle', 'walrus', 'wizard', 'yogurt', 'zebra', 'zigzag',
];

const WORD_SET = new Set(WORDS);

/** Two random words joined with `-` (16 bits from the CSPRNG). */
export function randomWords(): string {
  const pick = new Uint8Array(2);
  crypto.getRandomValues(pick);
  return `${WORDS[pick[0]!]}-${WORDS[pick[1]!]}`;
}

export interface ParsedCode {
  nameplate: string;
  /** The whole normalized code — the PAKE password. */
  password: string;
}

/**
 * Parse what a person typed. Case, spaces and separators are forgiving
 * (`42 Tiger ocean`, `042-tiger-ocean`). Null unless it's a number plus two
 * words from the list.
 */
export function parseCode(input: string): ParsedCode | null {
  const parts = input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.length !== 3) return null;
  const [nameplate, a, b] = parts as [string, string, string];
  if (!/^\d{1,5}$/.test(nameplate) || !WORD_SET.has(a) || !WORD_SET.has(b)) return null;
  const n = String(Number(nameplate));
  return { nameplate: n, password: `${n}-${a}-${b}` };
}

/** Words from the list starting with `prefix` (typing hints). */
export function suggestWords(prefix: string, limit = 5): string[] {
  const p = prefix.toLowerCase();
  if (!p) return [];
  return WORDS.filter((w) => w.startsWith(p)).slice(0, limit);
}
