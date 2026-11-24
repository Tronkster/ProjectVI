// In-game name rules, used by the launcher (live validation) and later by game servers.

const NAME_MIN = 3;
const NAME_MAX = 24;
const ALLOWED = /^[A-Za-z0-9 _.-]+$/;

// Returns { ok: true, name } with the trimmed name, or { ok: false, error } with a message for the player.
function validatePlayerName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length < NAME_MIN) return { ok: false, error: `Use at least ${NAME_MIN} characters.` };
  if (name.length > NAME_MAX) return { ok: false, error: `Use at most ${NAME_MAX} characters.` };
  if (!ALLOWED.test(name)) return { ok: false, error: "Use only letters, numbers, spaces and _ - ." };
  if (/\s{2,}/.test(name)) return { ok: false, error: "Don't use double spaces." };
  return { ok: true, name };
}

// Turns any display name (for example a Discord name) into a valid in-game name, or "" if that isn't possible.
function suggestPlayerName(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 _.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return validatePlayerName(cleaned).ok ? cleaned : "";
}

module.exports = { NAME_MIN, NAME_MAX, validatePlayerName, suggestPlayerName };
