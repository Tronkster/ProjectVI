// Project-wide constants. Change REPO once the GitHub repository exists, e.g. "yourname/projectvi".
//
// "OWNER/REPO" is deliberately unresolvable. Until it's replaced, auto-update and the public
// mod registry stay switched off instead of pointing at a GitHub account someone else might own.
const REPO = "hfnissum-byte/ProjectVI";
// The public mod list's repository. It has an index.json on its main branch.
const MODS_REPO = "Tronkster/ProjectVI-mods";

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const REPO_CONFIGURED = REPO !== "OWNER/REPO" && REPO_PATTERN.test(REPO);
const MODS_CONFIGURED = REPO_CONFIGURED && REPO_PATTERN.test(MODS_REPO);

module.exports = {
  REPO,
  REPO_CONFIGURED,
  REPO_URL: REPO_CONFIGURED ? `https://github.com/${REPO}` : "",
  MODS_REPO,
  DEFAULT_REGISTRY_URL: MODS_CONFIGURED ? `https://raw.githubusercontent.com/${MODS_REPO}/main/index.json` : "",
  DEFAULT_MASTER_URL: "http://localhost:30180",
  PROTOCOL_VERSION: 1
};
