// Ported from https://github.com/unjs/unbuild/blob/main/src/builders/rollup/plugins/shebang.ts

import { promises as fsp } from "node:fs";
import { resolve } from "pathe";
import type { Plugin } from "rolldown";

export const SHEBANG_RE: RegExp = /^#![^\n]*/;

export function shebangPlugin(): Plugin {
  return {
    name: "obuild-shebang",
    async writeBundle(options, bundle): Promise<void> {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") {
          continue;
        }
        if (hasShebang(output.code)) {
          const outFile = resolve(options.dir!, fileName);
          await makeExecutable(outFile);
        }
      }
    },
  };
}

export function hasShebang(code: string): boolean {
  return SHEBANG_RE.test(code);
}

export async function makeExecutable(filePath: string): Promise<void> {
  await fsp.chmod(filePath, 0o755 /* rwx r-x r-x */).catch(() => {});
}
