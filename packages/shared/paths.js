// Checks relative paths that come from game servers and mod zips before they touch the disk.
// Accepts forward-slash paths like "ui/hud/main.lua"; rejects anything that could escape a folder
// or that Windows can't store.

const MAX_PATH_LENGTH = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\\\p{Cc}]/u;

function isSafeSegment(part) {
  return (
    part !== "" &&
    part !== "." &&
    part !== ".." &&
    !BAD_CHARS.test(part) &&
    !/[. ]$/.test(part) && // Windows silently drops trailing dots and spaces
    !WINDOWS_RESERVED.test(part)
  );
}

function isSafeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.startsWith("/")) return false;
  return path.split("/").every(isSafeSegment);
}

module.exports = { MAX_PATH_LENGTH, isSafeRelativePath };
