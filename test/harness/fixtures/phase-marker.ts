import { writeFileSync } from "node:fs";
import { join } from "node:path";

// records that a phase fixture ran and which worker ran it
export const mark = (name: string): void => {
  writeFileSync(join(process.env.HARNESS_MARKERS ?? "", `${name}.json`), JSON.stringify({ worker: process.pid }));
};

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
