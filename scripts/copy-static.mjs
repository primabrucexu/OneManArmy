import { cp, mkdir, rm } from "node:fs/promises";

const target = new URL("../dist/static/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(new URL("../src/static/", import.meta.url), target, { recursive: true });
