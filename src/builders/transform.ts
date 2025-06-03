import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "pathe";

import { defu } from "defu";
import { consola } from "consola";
import { glob } from "tinyglobby";
import { colors as c } from "consola/utils";
import { readTSConfig, type TSConfig } from "pkg-types";

import { createTransformer } from "../transformers/index.ts";
import { getVueDeclarations } from "./utils/vue-dts.ts";
import { fmtPath } from "../utils.ts";
import type { OutputFile } from "../transformers/types.ts";
import type { BuildContext, TransformEntry } from "../types.ts";
import {
  hasFileShebang,
  hasShebang,
  makeExecutable,
} from "./plugins/shebang.ts";
import {
  getDeclarations,
  normalizeCompilerOptions,
  type DeclarationOptions,
  type DeclarationOutput,
} from "./utils/dts.ts";

/**
 * Transform all files in a directory using oxc-transform.
 */
export async function transformDir(
  context: BuildContext,
  entry: TransformEntry,
): Promise<void> {
  if (entry.stub) {
    consola.log(
      `${c.magenta("[stub transform]   ")} ${c.underline(fmtPath(entry.outDir!) + "/")}`,
    );
    await symlink(entry.input, entry.outDir!, "junction");
    return;
  }

  const transformer = createTransformer(entry.transformers, entry);
  const inputFileNames = await glob("**/*.*", { cwd: entry.input });
  const transformPromises: Promise<OutputFile[]>[] = inputFileNames.map(
    async (inputFileName) => {
      const inputFilePath = join(entry.input, inputFileName);

      return transformer.transformFile({
        path: inputFileName,
        extension: extname(inputFilePath),
        srcPath: inputFilePath,
        getContents() {
          return readFile(inputFilePath, "utf8");
        },
      });
    },
  );

  const outputFiles = await Promise.all(transformPromises).then((results) =>
    results.flat(),
  );

  const dtsOutputFiles = outputFiles.filter(
    (output) =>
      output.srcPath !== undefined &&
      !output.skip &&
      output.declaration === true,
  ) as Array<OutputFile & { srcPath: string }>;

  if (dtsOutputFiles.length > 0) {
    for (const output of dtsOutputFiles) {
      if (output.extension !== ".d.mts") {
        continue;
      }

      // If the desired extension is `.d.mts` the input files must be `.mts`
      output.srcPath = output.srcPath.replace(/\.ts$/, ".mts");
    }

    const declarationOptions: DeclarationOptions = {
      ...entry.declaration,
      rootDir: context.pkgDir,
      typescript: await resolveTSConfig(entry),
    };

    const vfs = new Map(
      dtsOutputFiles.map((o) => [o.srcPath, o.contents || ""]),
    );

    const declarations: DeclarationOutput = Object.create(null);
    for (const dtsGenerator of [getVueDeclarations, getDeclarations]) {
      Object.assign(declarations, await dtsGenerator(vfs, declarationOptions));
    }

    for (const output of dtsOutputFiles) {
      const result = declarations[output.srcPath];

      output.type = "declaration";
      output.contents = result?.contents || "";

      if (result.errors) {
        output.skip = true;

        consola.warn(
          `\n${c.yellow("[transform] ")}${c.dim(fmtPath(output.srcPath))}:\n` +
            result.errors.map((e) => `  - ${e}`).join("\n"),
        );
      }
    }
  }

  // Rename output files to their new extensions
  for (const output of outputFiles.filter((output) => output.extension)) {
    const originalExtension = extname(output.path);

    if (originalExtension === output.extension) {
      continue;
    }

    output.path = join(
      dirname(output.path),
      basename(output.path, originalExtension) + output.extension,
    );
  }

  const outputPromises: Promise<string>[] = outputFiles
    .filter((outputFile) => !outputFile.skip)
    .map(async (outputFile) => {
      const { path, raw, contents = "" } = outputFile;
      const outPath = join(entry.outDir!, path);

      await mkdir(dirname(outPath), { recursive: true });

      let shebangFound: boolean;

      if (raw) {
        const srcPath = outputFile.srcPath || join(entry.input, path);

        [shebangFound] = await Promise.all([
          // Avoid loading possibly large raw file contents into memory
          hasFileShebang(srcPath),
          copyFile(srcPath, outPath),
        ]);
      } else {
        shebangFound = hasShebang(contents);
        await writeFile(outPath, contents, "utf8");
      }

      if (shebangFound) {
        await makeExecutable(outPath);
      }

      return outPath;
    });

  const writtenFiles = await Promise.all(outputPromises);

  consola.log(
    `\n${c.magenta("[transform] ")}${c.underline(fmtPath(entry.outDir!) + "/")}\n${writtenFiles
      .map((f) => c.dim(fmtPath(f)))
      .join("\n")}`,
  );
}

async function resolveTSConfig(entry: TransformEntry): Promise<TSConfig> {
  // Read the TypeScript configuration from tsconfig.json
  const packageTsConfig = await readTSConfig();

  // Override the TypeScript configuration with the entry's declaration options
  const tsConfig: TSConfig = defu(
    entry.declaration?.typescript || {},
    packageTsConfig,
  );

  if (tsConfig.compilerOptions) {
    tsConfig.compilerOptions = await normalizeCompilerOptions(
      tsConfig.compilerOptions,
    );
  }

  // Ensure the TypeScript configuration has the necessary defaults
  tsConfig.compilerOptions = defu(
    {
      noEmit: false,
    } satisfies TSConfig["compilerOptions"],
    tsConfig.compilerOptions,
    {
      allowJs: true,
      declaration: true,
      skipLibCheck: true,
      strictNullChecks: true,
      emitDeclarationOnly: true,
      allowImportingTsExtensions: true,
      allowNonTsExtensions: true,
    } satisfies TSConfig["compilerOptions"],
  );

  return tsConfig;
}
