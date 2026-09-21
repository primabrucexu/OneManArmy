import { copyFile, cp, mkdir, rm } from "node:fs/promises";

const target = new URL("../dist/static/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(new URL("../src/static/", import.meta.url), target, { recursive: true });

const iconTarget = new URL("icons/", target);
const iconSource = new URL(
  "../node_modules/@phosphor-icons/web/src/regular/",
  import.meta.url,
);
await mkdir(iconTarget, { recursive: true });
await copyFile(new URL("style.css", iconSource), new URL("phosphor.css", iconTarget));
await copyFile(new URL("Phosphor.woff2", iconSource), new URL("Phosphor.woff2", iconTarget));
