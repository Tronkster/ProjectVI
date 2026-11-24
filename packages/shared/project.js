// Project-wide constants. Change REPO once the GitHub repository exists, e.g. "yourname/projectvi".
//
// "OWNER/REPO" is deliberately unresolvable. Until it's replaced, auto-update and the public
// mod registry stay switched off instead of pointing at a GitHub account someone else might own.
const REPO = "OWNER/REPO";

const REPO_CONFIGURED = REPO !== "OWNER/REPO" && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(REPO);

module.exports = {
  REPO,
  REPO_CONFIGURED,
  REPO_URL: REPO_CONFIGURED ? `https://github.com/${REPO}` : "",
  // The public mod registry lives in a sibling repo: <owner>/<repo>-mods.
  DEFAULT_REGISTRY_URL: REPO_CONFIGURED ? `https://raw.githubusercontent.com/${REPO}-mods/main/index.json` : "",
  DEFAULT_MASTER_URL: "http://localhost:30180",
  PROTOCOL_VERSION: 1
};
