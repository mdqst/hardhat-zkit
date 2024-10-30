import os from "os";
import path from "path";
import fs from "fs";

import { lazyObject } from "hardhat/plugins";
import { extendConfig, extendEnvironment, scope, task, subtask, types } from "hardhat/config";
import { ActionType, HardhatRuntimeEnvironment, RunSuperFunction } from "hardhat/types";
import { TASK_CLEAN, TASK_COMPILE_SOLIDITY_READ_FILE as TASK_READ_FILE } from "hardhat/builtin-tasks/task-names";
import { willRunWithTypescript } from "hardhat/internal/core/typescript-support";

import {
  CircuitZKit,
  CircuitZKitConfig,
  VerifierLanguageType,
  ProvingSystemType,
  IProtocolImplementer,
  Groth16Implementer,
  PlonkImplementer,
} from "@solarity/zkit";
import { CircuitTypesGenerator } from "@solarity/zktype";

import "./type-extensions";

import {
  ZKIT_SCOPE_NAME,
  TASK_CIRCUITS_COMPILE,
  TASK_CIRCUITS_MAKE,
  TASK_CIRCUITS_SETUP,
  TASK_GENERATE_VERIFIERS,
  TASK_ZKIT_CLEAN,
  SUBTASK_ZKIT_GET_CIRCUIT_ZKIT,
} from "./task-names";

import { zkitConfigExtender } from "./config/config";

import {
  CircuitsCompileCache,
  CircuitsSetupCache,
  createCircuitsCompileCache,
  createCircuitsSetupCache,
} from "./cache";
import {
  CompilationProcessor,
  CompilationFilesResolver,
  TypeGenerationProcessor,
  SetupProcessor,
  SetupFilesResolver,
} from "./core";

import { HardhatZKitError } from "./errors";
import { Reporter, createReporter } from "./reporter";
import { CircuitArtifacts } from "./artifacts/CircuitArtifacts";
import { CIRCUITS_COMPILE_CACHE_FILENAME, CIRCUITS_SETUP_CACHE_FILENAME } from "./constants";
import { getNormalizedFullPath, getUniqueProvingSystems } from "./utils";
import { isVersionValid } from "./core/compiler/versioning";

import {
  MakeTaskConfig,
  CompileTaskConfig,
  GenerateVerifiersTaskConfig,
  GetCircuitZKitConfig,
  SetupTaskConfig,
} from "./types/tasks";
import { CircuitArtifact } from "./types/artifacts/circuit-artifacts";
import { CompileFlags, CircomResolvedFileInfo, CircuitSetupInfo, SetupContributionSettings } from "./types/core";
import { ProvingSystemData } from "./types/cache";

const zkitScope = scope(ZKIT_SCOPE_NAME, "The ultimate TypeScript environment for Circom development");

extendConfig(zkitConfigExtender);

extendEnvironment((hre) => {
  hre.zkit = lazyObject(() => {
    const circuitArtifacts: CircuitArtifacts = new CircuitArtifacts(
      getNormalizedFullPath(hre.config.paths.root, hre.config.zkit.compilationSettings.artifactsDir),
    );

    return {
      circuitArtifacts,
      getCircuit: async (
        circuitName: string,
        provingSystem: ProvingSystemType = "groth16",
      ): Promise<CircuitZKit<typeof provingSystem>> => {
        return hre.run(SUBTASK_ZKIT_GET_CIRCUIT_ZKIT, { circuitName, provingSystem });
      },
    };
  });
});

const compile: ActionType<CompileTaskConfig> = async (taskArgs: CompileTaskConfig, env: HardhatRuntimeEnvironment) => {
  const circuitsCompileCacheFullPath: string = getNormalizedFullPath(
    env.config.paths.cache,
    CIRCUITS_COMPILE_CACHE_FILENAME,
  );

  createReporter(taskArgs.quiet || env.config.zkit.quiet);
  await createCircuitsCompileCache(circuitsCompileCacheFullPath);

  const compilationFileResolver: CompilationFilesResolver = new CompilationFilesResolver(
    (absolutePath: string) => env.run(TASK_READ_FILE, { absolutePath }),
    env.zkit.circuitArtifacts,
    env.config,
  );

  const optimization = taskArgs.optimization || env.config.zkit.compilationSettings.optimization;

  // Flags for specifying the necessary configurations during the setup process.
  // R1CS, Wasm, and Sym flags are mandatory
  const compileFlags: CompileFlags = {
    r1cs: true,
    wasm: true,
    sym: true,
    json: taskArgs.json || env.config.zkit.compilationSettings.json,
    c: taskArgs.c || env.config.zkit.compilationSettings.c,
    O0: optimization === "O0",
    O1: optimization === "O1",
    O2: optimization === "O2",
  };

  Reporter!.reportCircuitFilesResolvingProcessHeader();
  Reporter!.verboseLog("index", "Compile flags: %O", [compileFlags]);

  const resolvedFilesInfo: CircomResolvedFileInfo[] = await compilationFileResolver.getResolvedFilesToCompile(
    compileFlags,
    taskArgs.force,
  );

  const configCompilerVersion = env.config.zkit.compilerVersion;

  if (configCompilerVersion && !isVersionValid(configCompilerVersion)) {
    throw new HardhatZKitError(`Invalid Circom compiler version ${configCompilerVersion} specified in the config`);
  }

  if (resolvedFilesInfo.length > 0) {
    const compilationProcessor: CompilationProcessor = new CompilationProcessor(
      {
        compileFlags,
        quiet: taskArgs.quiet || env.config.zkit.quiet,
      },
      env.zkit.circuitArtifacts,
      env,
    );

    const provingSystems: ProvingSystemType[] = getUniqueProvingSystems(
      env.config.zkit.setupSettings.contributionSettings.provingSystem,
    );

    await compilationProcessor.compile(resolvedFilesInfo, provingSystems);

    await new TypeGenerationProcessor(env).generateAllTypes();

    for (const fileInfo of resolvedFilesInfo) {
      for (const file of [fileInfo.resolvedFile, ...fileInfo.dependencies]) {
        CircuitsCompileCache!.addFile(file.absolutePath, {
          lastModificationDate: file.lastModificationDate.valueOf(),
          contentHash: file.contentHash,
          sourceName: file.sourceName,
          compileFlags,
          fileData: file.fileData,
        });
      }
    }
  } else {
    Reporter!.reportNothingToCompile();
  }

  await CircuitsCompileCache!.writeToFile(circuitsCompileCacheFullPath);
};

const setup: ActionType<SetupTaskConfig> = async (taskArgs: SetupTaskConfig, env: HardhatRuntimeEnvironment) => {
  const circuitsSetupCacheFullPath: string = getNormalizedFullPath(
    env.config.paths.cache,
    CIRCUITS_SETUP_CACHE_FILENAME,
  );

  createReporter(taskArgs.quiet || env.config.zkit.quiet);
  await createCircuitsSetupCache(circuitsSetupCacheFullPath);

  const setupFileResolver: SetupFilesResolver = new SetupFilesResolver(env.zkit.circuitArtifacts, env.config);
  const setupContributionSettings: SetupContributionSettings = {
    provingSystems: getUniqueProvingSystems(env.config.zkit.setupSettings.contributionSettings.provingSystem),
    contributions: env.config.zkit.setupSettings.contributionSettings.contributions,
  };

  const circuitSetupInfoArr: CircuitSetupInfo[] = await setupFileResolver.getCircuitsInfoToSetup(
    setupContributionSettings,
    env.config.zkit.setupSettings,
    taskArgs.force,
  );

  if (circuitSetupInfoArr.length > 0) {
    let ptauDir = env.config.zkit.setupSettings.ptauDir;

    // If `ptauDir` is not specified in the configuration,
    // the `.zkit/ptau` folder in the user's home directory is used as the default location
    if (ptauDir) {
      ptauDir = path.isAbsolute(ptauDir) ? ptauDir : getNormalizedFullPath(env.config.paths.root, ptauDir);
    } else {
      ptauDir = path.join(os.homedir(), ".zkit", "ptau");
    }

    const setupProcessor: SetupProcessor = new SetupProcessor(ptauDir, env.zkit.circuitArtifacts);

    await setupProcessor.setup(circuitSetupInfoArr, setupContributionSettings);

    await new TypeGenerationProcessor(env).generateAllTypes();

    for (const setupInfo of circuitSetupInfoArr) {
      const currentSetupCacheEntry = CircuitsSetupCache!.getEntry(setupInfo.circuitArtifactFullPath);

      let currentProvingSystemsData: ProvingSystemData[] = [];

      if (currentSetupCacheEntry) {
        currentProvingSystemsData = currentSetupCacheEntry.provingSystemsData.filter((data: ProvingSystemData) => {
          return !setupInfo.provingSystems.includes(data.provingSystem);
        });
      }

      CircuitsSetupCache!.addFile(setupInfo.circuitArtifactFullPath, {
        circuitSourceName: setupInfo.circuitArtifact.circuitSourceName,
        r1csSourcePath: setupInfo.r1csSourcePath,
        provingSystemsData: [
          ...currentProvingSystemsData,
          ...setupContributionSettings.provingSystems.map((provingSystem) => {
            return {
              provingSystem,
              lastR1CSFileHash: setupInfo.r1csContentHash,
            };
          }),
        ],
        contributionsNumber: setupContributionSettings.contributions,
      });
    }
  } else {
    Reporter!.reportNothingToSetup();
  }

  await CircuitsSetupCache!.writeToFile(circuitsSetupCacheFullPath);
};

const make: ActionType<MakeTaskConfig> = async (taskArgs: MakeTaskConfig, env: HardhatRuntimeEnvironment) => {
  await env.run({ scope: ZKIT_SCOPE_NAME, task: TASK_CIRCUITS_COMPILE }, taskArgs);

  Reporter!.reportCompilationBottomLine();

  await env.run(
    { scope: ZKIT_SCOPE_NAME, task: TASK_CIRCUITS_SETUP },
    { force: taskArgs.force, quiet: taskArgs.quiet },
  );
};

const generateVerifiers: ActionType<GenerateVerifiersTaskConfig> = async (
  taskArgs: GenerateVerifiersTaskConfig,
  env: HardhatRuntimeEnvironment,
) => {
  if (!taskArgs.noCompile) {
    await env.run(
      { scope: ZKIT_SCOPE_NAME, task: TASK_CIRCUITS_MAKE },
      {
        quiet: taskArgs.quiet,
        force: taskArgs.force,
      },
    );
  } else {
    createReporter(taskArgs.quiet || env.config.zkit.quiet);
  }

  const verifiersDirFullPath: string = getNormalizedFullPath(
    env.config.paths.root,
    taskArgs.verifiersDir ?? env.config.zkit.verifiersSettings.verifiersDir,
  );
  const verifiersType: VerifierLanguageType = taskArgs.verifiersType ?? env.config.zkit.verifiersSettings.verifiersType;

  Reporter!.verboseLog("index", "Verifiers generation dir - %s", [verifiersDirFullPath]);

  const allFullyQualifiedNames: string[] = await env.zkit.circuitArtifacts.getAllCircuitFullyQualifiedNames();

  if (allFullyQualifiedNames.length > 0) {
    Reporter!.reportVerifiersGenerationHeader(verifiersType);

    const provingSystems: ProvingSystemType[] = getUniqueProvingSystems(
      env.config.zkit.setupSettings.contributionSettings.provingSystem,
    );
    const protocolImplementers = new Map<ProvingSystemType, IProtocolImplementer<ProvingSystemType>>();

    for (const name of allFullyQualifiedNames) {
      const circuitArtifact: CircuitArtifact = await env.zkit.circuitArtifacts.readCircuitArtifact(name);

      for (const provingSystem of provingSystems) {
        const spinnerId: string | null = Reporter!.reportVerifierGenerationStartWithSpinner(
          circuitArtifact.circuitTemplateName,
          verifiersType,
          provingSystem,
        );

        if (!protocolImplementers.has(provingSystem)) {
          switch (provingSystem) {
            case "groth16":
              protocolImplementers.set(provingSystem, new Groth16Implementer());
              break;
            case "plonk":
              protocolImplementers.set(provingSystem, new PlonkImplementer());
              break;
            default:
              throw new HardhatZKitError(`Unsupported proving system - ${provingSystem}`);
          }
        }

        const protocolImplementer: IProtocolImplementer<typeof provingSystem> =
          protocolImplementers.get(provingSystem)!;

        await new CircuitZKit<typeof provingSystem>(
          {
            circuitName: circuitArtifact.circuitTemplateName,
            circuitArtifactsPath: path.dirname(
              env.zkit.circuitArtifacts.formCircuitArtifactPathFromFullyQualifiedName(name),
            ),
            verifierDirPath: verifiersDirFullPath,
          },
          protocolImplementer,
        ).createVerifier(verifiersType);

        Reporter!.reportVerifierGenerationResult(
          spinnerId,
          circuitArtifact.circuitTemplateName,
          verifiersType,
          provingSystem,
        );
      }
    }

    Reporter!.reportVerifiersGenerationResult(verifiersType, allFullyQualifiedNames.length * provingSystems.length);
  } else {
    Reporter!.reportNothingToGenerate();
  }
};

const clean: ActionType<any> = async (_taskArgs: any, env: HardhatRuntimeEnvironment) => {
  const circuitsCompileCacheFullPath: string = getNormalizedFullPath(
    env.config.paths.cache,
    CIRCUITS_COMPILE_CACHE_FILENAME,
  );
  const circuitsSetupCacheFullPath: string = getNormalizedFullPath(
    env.config.paths.cache,
    CIRCUITS_SETUP_CACHE_FILENAME,
  );
  const artifactsDirFullPath: string = getNormalizedFullPath(
    env.config.paths.root,
    env.config.zkit.compilationSettings.artifactsDir,
  );
  const circuitTypesFullPath: string = getNormalizedFullPath(env.config.paths.root, env.config.zkit.typesDir);

  fs.rmSync(circuitsCompileCacheFullPath, { force: true });
  fs.rmSync(circuitsSetupCacheFullPath, { force: true });
  fs.rmSync(artifactsDirFullPath, { recursive: true, force: true });
  fs.rmSync(circuitTypesFullPath, { recursive: true, force: true });
};

const getCircuitZKit: ActionType<GetCircuitZKitConfig> = async (
  taskArgs: GetCircuitZKitConfig,
  env: HardhatRuntimeEnvironment,
): Promise<CircuitZKit<typeof taskArgs.provingSystem>> => {
  const circuitArtifact: CircuitArtifact = await env.zkit.circuitArtifacts.readCircuitArtifact(taskArgs.circuitName);

  const verifiersDirFullPath: string = getNormalizedFullPath(
    env.config.paths.root,
    taskArgs.verifiersDir ?? env.config.zkit.verifiersSettings.verifiersDir,
  );
  const circuitArtifactsDirPath: string = getNormalizedFullPath(
    env.zkit.circuitArtifacts.getCircuitArtifactsDirFullPath(),
    circuitArtifact.circuitSourceName,
  );

  const typesGenerator: CircuitTypesGenerator = new CircuitTypesGenerator({
    basePath: env.config.zkit.circuitsDir,
    projectRoot: env.config.paths.root,
    outputTypesDir: env.config.zkit.typesDir,
    circuitsArtifactsPaths: [],
  });

  const circuitZKitConfig: CircuitZKitConfig = {
    circuitName: circuitArtifact.circuitTemplateName,
    circuitArtifactsPath: circuitArtifactsDirPath,
    verifierDirPath: verifiersDirFullPath,
  };

  if (willRunWithTypescript(env.hardhatArguments.config)) {
    const module = await typesGenerator.getCircuitObject(taskArgs.circuitName);

    return new module(circuitZKitConfig);
  } else {
    let protocolImplementer: IProtocolImplementer<typeof taskArgs.provingSystem>;

    switch (taskArgs.provingSystem) {
      case "groth16":
        protocolImplementer = new Groth16Implementer();
        break;
      case "plonk":
        protocolImplementer = new PlonkImplementer();
        break;
      default:
        throw new HardhatZKitError(`Unsupported proving system - ${taskArgs.provingSystem}`);
    }

    return new CircuitZKit<typeof taskArgs.provingSystem>(circuitZKitConfig, protocolImplementer);
  }
};

task(TASK_CLEAN).setAction(async (_taskArgs: any, env: HardhatRuntimeEnvironment, runSuper: RunSuperFunction<any>) => {
  await runSuper();

  await env.run({ scope: ZKIT_SCOPE_NAME, task: TASK_ZKIT_CLEAN });
});

zkitScope
  .task(TASK_CIRCUITS_MAKE, "Compile Circom circuits and generate all necessary artifacts")
  .addFlag("json", "Outputs constraints in json file in the compilation artifacts directory.")
  .addFlag("c", "Enables the generation of cpp files in the compilation artifacts directory.")
  .addFlag("force", "Force compilation ignoring cache.")
  .addFlag("quiet", "Suppresses logs during the compilation process.")
  .setAction(make);

zkitScope
  .task(TASK_CIRCUITS_COMPILE, "Compile Circom circuits")
  .addFlag("json", "Outputs constraints in json file in the compilation artifacts directory.")
  .addFlag("c", "Enables the generation of cpp files in the compilation artifacts directory.")
  .addFlag("force", "Force compilation ignoring cache.")
  .addOptionalParam(
    "optimization",
    "Optimization flag for constraint simplification. Use 'O0' for no simplification, 'O1' for signal-to-signal and signal-to-constant simplification, and 'O2' for full simplification.",
    undefined,
    types.string,
  )
  .setAction(compile);

zkitScope
  .task(TASK_CIRCUITS_SETUP, "Create ZKey and Vkey files for compiled circuits")
  .addFlag("force", "Force compilation ignoring cache.")
  .addFlag("quiet", "Suppresses logs during the compilation process.")
  .setAction(setup);

zkitScope
  .task(TASK_GENERATE_VERIFIERS, "Generate Solidity | Vyper verifier contracts for Circom circuits")
  .addOptionalParam(
    "verifiersDir",
    "Relative path to the directory where the generated verifier contracts will be saved.",
    undefined,
    types.string,
  )
  .addOptionalParam(
    "verifiersType",
    "Verifier contracts laguage to generate. Use 'sol' for Solidity and 'vy' for Vyper",
    undefined,
    types.string,
  )
  .addFlag("noCompile", "Disable compilation before verifiers generation.")
  .addFlag("force", "Force compilation ignoring cache.")
  .addFlag("quiet", "Suppresses logs during the verifier generation process.")
  .setAction(generateVerifiers);

zkitScope.task(TASK_ZKIT_CLEAN, "Clean all circuit artifacts, keys, types and etc").setAction(clean);

subtask(SUBTASK_ZKIT_GET_CIRCUIT_ZKIT)
  .addOptionalParam("verifiersDir", undefined, undefined, types.string)
  .addOptionalParam("verifierTemplateType", undefined, undefined, types.any)
  .addParam("circuitName", undefined, undefined, types.string)
  .setAction(getCircuitZKit);
