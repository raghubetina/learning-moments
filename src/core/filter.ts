import path from "node:path";
import { minimatch } from "minimatch";
import type { LearningMomentsConfig } from "./config.js";

export function candidateFiles(files: string[], config: LearningMomentsConfig): string[] {
  return files.filter((file) => {
    const extension = path.extname(file);
    if (config.ignore.extensions.includes(extension)) {
      return false;
    }
    return !config.ignore.paths.some((pattern) => minimatch(file, pattern, { dot: true }));
  });
}
