// joaat ("Jenkins one-at-a-time"), the hash the game uses for model, weapon and other names.
// The game lowercases names before hashing, so "Adder" and "adder" are the same model.

function joaat(name) {
  let h = 0;
  for (const byte of Buffer.from(String(name).toLowerCase(), "utf8")) {
    h = (h + byte) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

module.exports = { joaat };
