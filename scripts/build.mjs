import { mkdir, readFile, readdir, writeFile, copyFile } from "node:fs/promises";
const output = "dist/server";
await mkdir(output, { recursive: true });
const assetTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const assets = {};
for (const filename of await readdir("public")) {
  const mime = assetTypes[filename.slice(filename.lastIndexOf("."))];
  if (!mime) continue;
  const data = await readFile("public/" + filename);
  const value = mime.startsWith("image/png") ? data.toString("base64") : data.toString();
  assets["/" + filename] = [mime, value];
}
await writeFile(output + "/assets.js", "export default " + JSON.stringify(assets) + ";\n");
for (const file of await readdir("worker")) await copyFile("worker/" + file, output + "/" + file);
for (const file of ["analytics.js", "market.js"]) await copyFile("public/" + file, output + "/" + file);
