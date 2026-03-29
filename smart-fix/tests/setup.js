const path = require("path");
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function fixturePath(project, ...parts) {
  return path.join(FIXTURES_DIR, project, ...parts);
}

function readFixture(project, ...parts) {
  return require("fs").readFileSync(fixturePath(project, ...parts), "utf-8");
}

module.exports = { FIXTURES_DIR, fixturePath, readFixture };
