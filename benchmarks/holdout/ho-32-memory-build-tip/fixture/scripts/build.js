const fs = require("fs");
const path = require("path");
fs.mkdirSync(path.join(process.cwd(), "dist"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "dist", "bundle.txt"), "BUILD OK\n");
console.log("build complete");
